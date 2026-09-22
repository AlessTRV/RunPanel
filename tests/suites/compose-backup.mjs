import { client, createReporter, docker, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Compose project's volume, backed up and put back, against a real daemon.
 *
 * The regression: Compose refuses `--label` on `up`, so a stack's volumes
 * carry only `com.docker.compose.project=runpanel-<slug>`, and the backup only
 * ever asked for RunPanel's own labels. A policy with "volumi" on a Compose
 * project produced an archive without a single byte of its data, and said so
 * nowhere.
 *
 * The stack writes into its volume continuously, so "the writer was paused
 * during the copy" is something the run has to have done rather than
 * something it could get away with skipping. The unit suite covers the
 * orderings; this one covers the real `docker pause`, `tar --exclude` and the
 * restore script on a real engine.
 */
export const meta = { name: "compose-backup", needsDocker: true, drivers: ["sqlite"] };

async function waitFor(api, url, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(url);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`${url} non è finito in tempo`);
    await sleep(500);
  }
}

export async function run({ base, dataDir }) {
  const r = createReporter("compose-backup");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "compose-backup-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Compose Backup Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;
  const stack = `runpanel-${slug}`;
  const volume = `${stack}_data`;
  // A stack whose name only starts the same. Created by hand, labelled like
  // Compose would, and removed by its exact name at the end.
  const decoy = `${stack}2_data`;

  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "docker-compose.yml"), `services:
  writer:
    image: alpine
    command: ["sh","-c","while true; do date >> /data/live.log; sleep 0.2; done"]
    volumes:
      - data:/data
  reader:
    image: alpine
    command: ["sh","-c","while true; do sleep 1; done"]
    volumes:
      - data:/data:ro
volumes:
  data:
`);

  const cleanup = async () => {
    await api.call(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
    // Compose keeps named volumes on `down`; these two are this suite's own.
    for (const name of [volume, decoy]) {
      try {
        docker("volume", "rm", name);
      } catch {
        /* already gone */
      }
    }
  };

  try {
    await api.call(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({
        runtimeType: "compose",
        sourceType: "upload",
        builderConfig: { version: 1, healthcheck: { enabled: false } },
      }),
    });
    await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
    const status = await waitForDeploy(api, projectId);
    r.check("the stack is deployed", status === "running", `status=${status}`);
    if (status !== "running") return r.result();

    const container = (service) =>
      docker(
        "ps", "-q",
        "--filter", `label=com.docker.compose.project=${stack}`,
        "--filter", `label=com.docker.compose.service=${service}`
      ).split("\n")[0];
    const writer = container("writer");
    const reader = container("reader");
    const inVolume = (script) => docker("exec", writer, "sh", "-c", script);

    inVolume("echo v1 > /data/keep.txt && mkdir -p /data/trades && head -c 3000000 /dev/urandom > /data/trades/big.bin");
    docker("volume", "create", "--label", `com.docker.compose.project=${stack}2`, "--label", "com.docker.compose.volume=data", decoy);

    r.check(
      "the stack's volume carries only Compose's labels",
      !docker("volume", "inspect", volume, "--format", "{{json .Labels}}").includes("runpanel.managed"),
      docker("volume", "inspect", volume, "--format", "{{json .Labels}}")
    );

    // --- settings -----------------------------------------------------------------
    const saved = await api.call(`/api/projects/${projectId}/backup`, {
      method: "PUT",
      body: JSON.stringify({ consistency: "pause", preBackup: null, excludes: { [volume]: ["trades/"] } }),
    });
    r.check("the exclusion is saved", saved.status === 200, JSON.stringify(saved.body));

    const view = await api.call(`/api/projects/${projectId}/backup`);
    const listed = view.body?.volumes ?? [];
    r.check(
      "the settings page lists the stack's volume, as Compose's",
      listed.some((entry) => entry.name === volume && entry.origin === "compose" && entry.composeVolume === "data"),
      JSON.stringify(listed)
    );
    r.check("but not the decoy's", !listed.some((entry) => entry.name === decoy));
    r.check(
      "it knows who writes and who only reads",
      listed.find((entry) => entry.name === volume)?.users.some((u) => u.name.includes("writer") && u.rw) &&
        listed.find((entry) => entry.name === volume)?.users.some((u) => u.name.includes("reader") && !u.rw),
      JSON.stringify(listed.find((entry) => entry.name === volume)?.users)
    );
    r.check("and offers the stack's services for a pre-backup command", ["reader", "writer"].every((s) => view.body?.services?.includes(s)), JSON.stringify(view.body?.services));

    // --- backup ---------------------------------------------------------------------
    const destinations = await api.call("/api/backups/destinations");
    const policy = await api.call("/api/backups/policies", {
      method: "POST",
      body: JSON.stringify({
        name: "Tutti i volumi",
        cron: "",
        destinationId: destinations.body.destinations[0].id,
        targets: [{ kind: "all-projects", include: ["config", "volumes"] }],
      }),
    });
    const started = await api.call(`/api/backups/policies/${policy.body.id}/run`, { method: "POST" });
    const finished = await waitFor(api, `/api/backups/runs/${started.body.runId}`);
    r.check("the backup succeeds", finished.status === "success", `${finished.status} ${finished.errorMessage ?? ""}`);

    const artifact = finished.artifacts?.find((entry) => entry.kind === "project-volume" && entry.meta?.volume === volume);
    r.check("all-projects produces an artifact for the Compose volume", artifact?.status === "ok", JSON.stringify(finished.artifacts));
    r.check(
      "and none for the stack whose name only starts the same",
      !finished.artifacts?.some((entry) => entry.meta?.volume === decoy)
    );
    if (!artifact) return r.result();

    const consistency = artifact.meta.consistency ?? {};
    r.check("the copy is marked consistent", consistency.result === "paused", JSON.stringify(consistency));
    r.check(
      "the writer was paused, the read-only reader was not",
      consistency.paused?.some((name) => name.includes("writer")) && !consistency.paused?.some((name) => name.includes("reader")),
      JSON.stringify(consistency.paused)
    );
    r.check("taken as a snapshot, compressed after the pause", consistency.method === "snapshot", String(consistency.method));
    r.check("the manifest records the exclusion", JSON.stringify(artifact.meta.excludes) === '["trades"]', JSON.stringify(artifact.meta.excludes));
    r.check(
      "with the size it would have had",
      artifact.meta.excluded?.[0]?.bytes >= 2_900_000,
      JSON.stringify(artifact.meta.excluded)
    );
    r.check("the volume's 3 MB of random data are not in the archive", artifact.bytes < 1_000_000, String(artifact.bytes));
    r.check(
      "the log says who was paused, for how long, and what was excluded",
      /in pausa: .*writer/.test(finished.log) && /ripresi dopo/.test(finished.log) && /esclusi: trades/.test(finished.log),
      finished.log.split("\n").filter((line) => line.startsWith("  ")).join(" | ")
    );
    r.check(
      "the stack is running again after the backup",
      docker("inspect", writer, "--format", "{{.State.Status}}") === "running",
      docker("inspect", writer, "--format", "{{.State.Status}}")
    );
    r.check("no container was left paused", !docker("ps", "--filter", "status=paused", "--format", "{{.Names}}").includes(slug));

    // --- restore --------------------------------------------------------------------
    inVolume("echo v2 > /data/keep.txt && echo junk > /data/junk.txt && echo later > /data/trades/after.txt");

    const restoreStarted = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId: finished.id,
        confirm: artifact.refName,
        targets: [{ artifactId: artifact.id, action: "restore" }],
      }),
    });
    r.check("the restore is accepted", restoreStarted.status === 202, JSON.stringify(restoreStarted.body));
    if (restoreStarted.status !== 202) return r.result();

    const restore = await waitFor(api, `/api/backups/restore/${restoreStarted.body.restoreId}`);
    r.check("the restore succeeds", restore.status === "success", `${restore.status} ${restore.errorMessage ?? ""}`);

    // The stack is restarted by the restore; read through a throwaway container
    // so the answer does not depend on which of its own came back first.
    const peek = (script) => docker("run", "--rm", "-v", `${volume}:/data:ro`, "alpine", "sh", "-c", script);
    r.check("the file comes back as it was in the backup", peek("cat /data/keep.txt") === "v1", peek("cat /data/keep.txt"));
    r.check("what was written after the backup is gone", peek("test -e /data/junk.txt && echo present || echo gone") === "gone");
    r.check(
      "the excluded folder is left exactly as it is, not emptied",
      peek("test -f /data/trades/big.bin && test -f /data/trades/after.txt && echo kept || echo lost") === "kept",
      peek("ls -la /data/trades")
    );
    const restoreLog = String(restore.log ?? "");
    r.check(
      "the restore log says it stopped the project and what it kept",
      restoreLog.includes("fermo") && restoreLog.includes("conservati come sono") && restoreLog.includes("trades"),
      restoreLog.slice(-600)
    );

    await sleep(1500);
    r.check(
      "and the stack is back up",
      ["writer", "reader"].every((service) => docker("inspect", container(service), "--format", "{{.State.Status}}") === "running")
    );
  } finally {
    await cleanup();
  }

  return r.result();
}
