import { client, createReporter, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The deploy must be visible WHILE it happens.
 *
 * Before the event stream the build log could only be read from a deployment
 * that had already finished — during a deploy the UI showed a "deploying" badge
 * and nothing else. The central assertion here is therefore not "the log
 * exists" but "the log arrives before the deploy ends".
 */
export const meta = { name: "realtime", needsDocker: true, drivers: ["sqlite"] };

export async function run({ base, dataDir }) {
  const r = createReporter("realtime");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "realtime-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Realtime Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;

  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });
  // Slow enough that there is a real window during which the browser should
  // already be seeing output.
  writeFileSync(join(repo, "Dockerfile"), `FROM alpine
RUN echo step-one && sleep 2 && echo step-two && sleep 2 && echo step-three
CMD ["sh","-c","while true; do sleep 1; done"]
`);

  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "docker",
      sourceType: "upload",
      builderConfig: { version: 1, healthcheck: { startPeriodSec: 1, timeoutSec: 30 } },
    }),
  });

  // Subscribe BEFORE deploying.
  const events = [];
  const controller = new AbortController();

  const reading = (async () => {
    const res = await fetch(`${base}/api/projects/${projectId}/stream`, {
      headers: { cookie: api.cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });

    r.check("stream responded", res.ok, String(res.status));
    r.check("content type is text/event-stream",
      (res.headers.get("content-type") ?? "").includes("text/event-stream"),
      res.headers.get("content-type") ?? "");
    r.check("stream is not cached",
      (res.headers.get("cache-control") ?? "").includes("no-store"),
      res.headers.get("cache-control") ?? "");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
        }
      }
    } catch { /* aborted */ }
  })();

  await sleep(600);
  r.check("a ready frame arrives before anything happens",
    events.some((e) => e.type === "ready"), JSON.stringify(events.slice(0, 3)));

  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });

  // Sample mid-deploy — this is the whole point.
  await sleep(6000);
  const midLogs = events.filter((e) => e.type === "deploy:log").length;
  const midStatus = (await api.call(`/api/projects/${projectId}`)).body.status;
  r.note(`after 6s: status=${midStatus}, ${midLogs} build lines already streamed`);
  r.check("build output arrives DURING the deploy, not after", midLogs > 0, `${midLogs} lines`);

  const status = await waitForDeploy(api, projectId);
  r.check("deploy reached running", status === "running", `status=${status}`);
  await sleep(1500);

  const logEvents = events.filter((e) => e.type === "deploy:log");
  const statusEvents = events.filter((e) => e.type === "deploy:status");
  r.note(`totals: ${logEvents.length} log events, ${statusEvents.length} status events`);

  r.check("status events were emitted", statusEvents.length >= 2,
    JSON.stringify(statusEvents.map((e) => e.status)));
  r.check("a terminal 'running' status came through",
    statusEvents.some((e) => e.status === "running"),
    JSON.stringify(statusEvents.map((e) => e.status)));

  // The old poller re-sent the same tail every few seconds, which is why the UI
  // needed a de-duplicating Set that also dropped legitimately repeated lines.
  const repeats = logEvents.map((e) => e.line).filter((l) => l.includes("step-two")).length;
  r.check("each build line is delivered once, not repeatedly", repeats <= 2, `"step-two" seen ${repeats}x`);

  const history = (await api.call(`/api/projects/${projectId}/logs`)).body;
  const full = await api.call(`/api/deployments/${history[0].id}`);
  r.check("a finished deployment still serves its log from disk",
    String(full.body.build_log ?? "").includes("step-three"),
    String(full.body.build_log ?? "").slice(0, 120));

  const tailed = await api.call(`/api/deployments/${history[0].id}?tail=5`);
  const tailLines = String(tailed.body.build_log ?? "").trim().split("\n").length;
  r.check("the tail parameter limits what is sent", tailLines <= 6, `${tailLines} lines`);

  controller.abort();
  await reading;
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
