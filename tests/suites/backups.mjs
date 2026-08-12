import { createReporter, client, SETUP_TOKEN } from "../harness.mjs";
import fs from "node:fs";
import path from "node:path";

/**
 * The backup API end to end, without Docker.
 *
 * The panel's own SQLite store is a target that needs no container, which makes
 * it possible to exercise the whole path — schedule, run, archive, download,
 * retention, delete — against a real server on any machine. The Docker-only
 * engines are covered separately.
 */
export const meta = { name: "backups", needsDocker: false, drivers: ["sqlite", "postgres"] };

const PASSWORD = "backup-suite-password";

async function waitForRun(api, runId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/runs/${runId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`Il backup ${runId} non è finito in tempo`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function run({ base, dataDir }) {
  const r = createReporter("backups");
  const api = client(base);

  // Only the SQLite store can be dumped without a container, so the parts of
  // this suite that actually produce an archive run there.
  const canDumpStore = fs.existsSync(path.join(dataDir, "runpanel.db"));

  // --- everything is behind the session -----------------------------------
  for (const [method, route] of [
    ["GET", "/api/backups/policies"],
    ["GET", "/api/backups/runs"],
    ["GET", "/api/backups/destinations"],
    ["GET", "/api/backups/targets"],
    ["POST", "/api/backups/cron-preview"],
  ]) {
    const { status } = await api.call(route, {
      method,
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
    });
    r.check(`${method} ${route} requires a session`, status === 401, String(status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: PASSWORD, confirmPassword: PASSWORD }),
  });

  // --- the local destination exists on its own -----------------------------
  const destinations = await api.call("/api/backups/destinations");
  r.check("a destination is created at boot", destinations.body?.destinations?.length === 1);
  const destination = destinations.body?.destinations?.[0];
  r.check("it is the local one", destination?.type === "local", JSON.stringify(destination));
  r.check("its encrypted config is never returned", destination?.config === undefined);

  const probe = await api.call(`/api/backups/destinations/${destination.id}`, { method: "POST" });
  r.check("it verifies as writable", probe.body?.ok === true, JSON.stringify(probe.body));

  // --- schedules are validated by the real parser --------------------------
  const badCron = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Sbagliata",
      cron: "0 25 * * *",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
    }),
  });
  r.check("an impossible hour is rejected", badCron.status === 400, String(badCron.status));

  const reboot = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Al riavvio",
      cron: "@reboot",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
    }),
  });
  r.check("@reboot is refused here too", reboot.status === 400, String(reboot.status));

  const noTargets = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({ name: "Vuota", cron: "", destinationId: destination.id, targets: [] }),
  });
  r.check("a policy with nothing to back up is rejected", noTargets.status === 400);

  // --- create --------------------------------------------------------------
  const created = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Notturno",
      cron: "0 3 * * *",
      timezone: "Europe/Rome",
      destinationId: destination.id,
      targets: [{ kind: "panel" }],
      retentionCount: 2,
    }),
  });
  r.check("a valid policy is created", created.status === 201, JSON.stringify(created.body));

  const policyId = created.body?.id;
  r.check("the schedule is described in words", created.body?.schedule === "ogni giorno alle 03:00", created.body?.schedule);
  r.check("the next run is computed immediately", Boolean(created.body?.nextRunAt), created.body?.nextRunAt);
  r.check(
    "creating it does not also run it",
    created.body?.lastRunAt === null,
    String(created.body?.lastRunAt)
  );

  const preview = await api.call("/api/backups/cron-preview", {
    method: "POST",
    body: JSON.stringify({ cron: "0 3 * * *", timezone: "Europe/Rome", count: 3 }),
  });
  r.check("the preview returns three occurrences", preview.body?.occurrences?.length === 3);
  r.check(
    "the preview and the policy agree on the wording",
    preview.body?.description === created.body?.schedule
  );

  // --- run it --------------------------------------------------------------
  if (canDumpStore) {
    const started = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    r.check("a manual run is accepted immediately", started.status === 202, String(started.status));

    const runId = started.body?.runId;
    r.check("it answers with an id the client can follow", Boolean(runId));

    // The row has to exist by the time the id is handed out, or the page that
    // opens a stream on it gets a 404.
    const immediately = await api.call(`/api/backups/runs/${runId}`);
    r.check("the run is queryable straight away", immediately.status === 200, String(immediately.status));

    const finished = await waitForRun(api, runId);
    r.check("the run succeeds", finished.status === "success", JSON.stringify(finished.errorMessage));
    r.check("it produced an archive", finished.hasArchive === true);
    r.check("the archive has a size", finished.archiveBytes > 0, String(finished.archiveBytes));
    r.check("the archive has a checksum", /^[0-9a-f]{64}$/.test(finished.checksum ?? ""), finished.checksum);

    const artifact = finished.artifacts?.find((entry) => entry.kind === "panel-store");
    r.check("the panel store was captured", artifact?.status === "ok", JSON.stringify(artifact));
    r.check(
      "integrity_check ran on the dump rather than being assumed",
      artifact?.meta?.integrityCheck === "ok",
      JSON.stringify(artifact?.meta)
    );
    r.check(
      "the row count is recorded, so an empty dump would be visible",
      typeof artifact?.meta?.projectCount === "number",
      JSON.stringify(artifact?.meta?.projectCount)
    );
    r.check("the log was kept", (finished.log ?? "").includes("store del pannello"), finished.log?.slice(0, 120));

    // --- download ----------------------------------------------------------
    const download = await fetch(`${base}/api/backups/runs/${runId}/download`, {
      headers: { cookie: api.cookie },
    });
    r.check("the archive downloads", download.status === 200, String(download.status));
    r.check(
      "it is served as a zip",
      download.headers.get("content-type") === "application/zip",
      download.headers.get("content-type")
    );
    r.check(
      "the digest travels with it",
      download.headers.get("x-checksum-sha256") === finished.checksum
    );

    const bytes = Buffer.from(await download.arrayBuffer());
    r.check("the body really is a zip", bytes.subarray(0, 2).toString() === "PK", bytes.subarray(0, 4).toString("hex"));
    r.check("the body is the whole archive", bytes.length === finished.archiveBytes, `${bytes.length}`);

    // --- an id that is not an id -------------------------------------------
    for (const hostile of ["..", "../../etc/passwd", "%2e%2e%2fsecret", "notarealid"]) {
      const { status } = await api.call(`/api/backups/runs/${encodeURIComponent(hostile)}/download`);
      r.check(`a hostile id gives 404, not 500: ${hostile}`, status === 404, String(status));
    }

    // --- restore -------------------------------------------------------------
    // Restoring the panel's own SQLite store does not swap it live — it stages
    // the file and a marker for the next boot — which makes it the one target
    // that can be exercised end to end inside a running test.
    const wrongConfirm = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId,
        confirm: "qualcos'altro",
        targets: [{ artifactId: artifact.id, action: "restore" }],
      }),
    });
    r.check(
      "a wrong confirmation is refused by the server, not just the browser",
      wrongConfirm.status === 400,
      JSON.stringify(wrongConfirm.body)
    );

    const startedRestore = await api.call("/api/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        runId,
        confirm: artifact.refName,
        targets: [{ artifactId: artifact.id, action: "restore" }],
      }),
    });
    r.check("a confirmed restore is accepted", startedRestore.status === 202, JSON.stringify(startedRestore.body));

    const restoreId = startedRestore.body?.restoreId;
    let restore = null;
    const restoreDeadline = Date.now() + 120_000;
    for (;;) {
      const { body } = await api.call(`/api/backups/restore/${restoreId}`);
      if (body?.status && body.status !== "running") {
        restore = body;
        break;
      }
      if (Date.now() > restoreDeadline) throw new Error("Il ripristino non è finito in tempo");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    r.check("the restore succeeds", restore.status === "success", JSON.stringify(restore.errorMessage));
    r.check("a safety backup was taken first", Boolean(restore.safetyRunId), String(restore.safetyRunId));

    const safety = await api.call(`/api/backups/runs/${restore.safetyRunId}`);
    r.check("the safety backup succeeded", safety.body?.status === "success");
    r.check(
      "and is exempt from retention, so it cannot be collected later",
      safety.body?.pinned === true
    );

    r.check(
      "the store is staged for the next boot rather than swapped underneath us",
      fs.existsSync(path.join(dataDir, "runpanel.restored.db")) &&
        fs.existsSync(path.join(dataDir, ".restore-pending"))
    );
    r.check(
      "the log says what will happen",
      (restore.log ?? "").includes("prossimo riavvio"),
      (restore.log ?? "").slice(-160)
    );

    // Leave the data directory as we found it: a marker left behind would make
    // the next boot swap a store this suite is done with.
    fs.rmSync(path.join(dataDir, ".restore-pending"), { force: true });
    fs.rmSync(path.join(dataDir, "runpanel.restored.db"), { force: true });

    // --- retention ----------------------------------------------------------
    // retentionCount is 2, so a third run should collect the first.
    const second = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    await waitForRun(api, second.body.runId);
    const third = await api.call(`/api/backups/policies/${policyId}/run`, { method: "POST" });
    await waitForRun(api, third.body.runId);

    const listed = await api.call(`/api/backups/runs?policyId=${policyId}`);
    const kept = listed.body?.runs ?? [];
    r.check("retention keeps exactly what was asked for", kept.length === 2, `${kept.length}`);
    r.check("it is the oldest that goes", !kept.some((entry) => entry.id === runId));

    const archives = path.join(dataDir, "backups", "archives");
    const listArchives = () => {
      const found = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".zip")) found.push(entry.name);
        }
      };
      if (fs.existsSync(archives)) walk(archives);
      return found;
    };
    // The safety copy taken before the restore is pinned, so retention must
    // leave it alone even though it belongs to no policy.
    const isPolicyArchive = (name) => !name.includes("sicurezza-pre-ripristino");

    const onDisk = listArchives();
    r.check(
      "the collected archive is gone from disk too",
      onDisk.filter(isPolicyArchive).length === 2,
      onDisk.join(", ")
    );
    r.check(
      "the pinned safety copy is not collected",
      onDisk.some((name) => !isPolicyArchive(name)),
      onDisk.join(", ")
    );
    r.check("no .part file survives a finished run", !onDisk.some((name) => name.endsWith(".part")));

    // --- deleting a run ------------------------------------------------------
    const doomed = kept[0].id;
    const removed = await api.call(`/api/backups/runs/${doomed}`, { method: "DELETE" });
    r.check("a run can be deleted", removed.status === 200, String(removed.status));

    const afterDelete = listArchives();
    r.check(
      "deleting the run deletes its archive",
      afterDelete.filter(isPolicyArchive).length === 1,
      afterDelete.join(", ")
    );
  } else {
    r.note("store Postgres: il dump richiede Docker, verifico solo la parte di configurazione");
  }

  // --- editing --------------------------------------------------------------
  const disabled = await api.call(`/api/backups/policies/${policyId}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  r.check("a policy can be switched off", disabled.body?.enabled === false);
  r.check(
    "switching it off clears the next run instead of leaving a stale one",
    disabled.body?.nextRunAt === null,
    String(disabled.body?.nextRunAt)
  );

  const manualOnly = await api.call(`/api/backups/policies/${policyId}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, cron: "" }),
  });
  r.check("an empty schedule means manual only", manualOnly.body?.schedule === "solo su richiesta");
  r.check("and has no next run", manualOnly.body?.nextRunAt === null);

  // --- the destination cannot be pulled out from under a policy -------------
  const inUse = await api.call(`/api/backups/destinations/${destination.id}`, { method: "DELETE" });
  r.check("a destination in use is not deleted", inUse.status === 409, String(inUse.status));

  const gone = await api.call(`/api/backups/policies/${policyId}`, { method: "DELETE" });
  r.check("a policy can be deleted", gone.status === 200);

  const afterPolicyDelete = await api.call("/api/backups/policies");
  r.check("and it is gone", afterPolicyDelete.body?.policies?.length === 0);

  if (canDumpStore) {
    // The runs outlive the policy on purpose: their archives are files, and a
    // cascade would leave them on disk with nothing that knows about them.
    const orphaned = await api.call("/api/backups/runs");
    r.check(
      "its runs survive, with the name kept for the history",
      orphaned.body?.runs?.[0]?.policyName === "Notturno",
      JSON.stringify(orphaned.body?.runs?.[0])
    );
    r.check("but no longer point at a policy", orphaned.body?.runs?.[0]?.policyId === null);
  }

  return r.result();
}
