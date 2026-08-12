import { client, createReporter, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Deploy serialisation.
 *
 * Two deploys of one project must never overlap — they share a checkout, a
 * container name and a port. A request that arrives during a deploy is queued
 * rather than refused, because refusing a webhook silently drops that push.
 *
 * Deliberately does NOT assert "the second request gets 409": with a no-source
 * project the deploy fails in milliseconds, so the lock is legitimately free
 * again by the time the next request lands. That would be a race, not a test.
 */
export const meta = { name: "deploy-queue", needsDocker: false, drivers: ["sqlite", "postgres"] };

const BURST = 6;

export async function run({ base }) {
  const r = createReporter("deploy-queue");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "queue-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Queue Suite" }),
  });
  const projectId = created.body.id;
  r.check("project created", Boolean(projectId), JSON.stringify(created.body));

  const results = await Promise.all(
    Array.from({ length: BURST }, () =>
      api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" })
    )
  );

  const started = results.filter((x) => x.body?.status === "pending").length;
  const queued = results.filter((x) => x.body?.status === "queued").length;
  const refused = results.filter((x) => x.status === 409).length;

  r.note(`${BURST} simultaneous requests -> ${started} started, ${queued} queued, ${refused} refused`);
  r.check(
    "every request got a definite answer",
    started + queued + refused === BURST,
    JSON.stringify(results.map((x) => `${x.status}:${x.body?.status}`))
  );

  // Let everything settle, including any queued follow-up.
  await sleep(10_000);

  const history = (await api.call(`/api/projects/${projectId}/logs`)).body;
  const rows = Array.isArray(history) ? history.length : -1;

  r.check("every started request produced a deployment", rows >= started, `rows=${rows} started=${started}`);
  r.check(
    "queued requests never produce more deployments than asked for",
    rows <= started + queued,
    `rows=${rows} started=${started} queued=${queued}`
  );
  if (queued > 1) {
    r.check(
      "simultaneous queued requests are coalesced into one follow-up",
      rows < started + queued,
      `rows=${rows}, would be ${started + queued} without coalescing`
    );
  }

  const spans = (history ?? [])
    .filter((d) => d.started_at && d.finished_at)
    .map((d) => ({ from: Date.parse(d.started_at), to: Date.parse(d.finished_at) }))
    .sort((a, b) => a.from - b.from);

  let overlap = null;
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to) { overlap = [spans[i - 1], spans[i]]; break; }
  }
  r.check("no two deploys of the same project overlapped", overlap === null, JSON.stringify(overlap));
  r.check("all deploys reached a terminal state", spans.length === (history ?? []).length,
    `${spans.length} of ${(history ?? []).length} finished`);

  const after = await api.call(`/api/projects/${projectId}`);
  r.check("project is not stuck on 'deploying'", after.body.status !== "deploying", after.body.status);

  // A project with no source has no directory on disk. Node reports a missing
  // cwd as ENOENT *on the executable*, so this used to fail with
  // "spawn C:\Windows\system32\cmd.exe ENOENT" — which reads as a broken shell
  // and sends you looking at PATH, Node and Windows instead of at the project.
  if (Array.isArray(history) && history[0]) {
    const log = (await api.call(`/api/deployments/${history[0].id}?tail=40`)).body?.build_log ?? "";
    r.check(
      "a source-less deploy names the missing source",
      /no (source|repository)/i.test(log),
      log.slice(-300)
    );
    r.check(
      "it does not blame the shell",
      !/cmd\.exe|ENOENT/i.test(log),
      log.slice(-300)
    );
  }

  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
