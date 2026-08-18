/**
 * Next calls `register()` once per server process, before the first request.
 *
 * Validating the environment here means a misconfigured deployment fails loudly
 * at boot with a list of what is wrong, instead of returning a 500 on whichever
 * request first happens to touch the database.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv } = await import("./lib/env");
  const env = getEnv();

  console.log(
    `[RunPanel] Booting — data dir ${env.dataDir}, store ${env.db.driver}`
  );

  // Before anything opens the store: a restore leaves the new database next to
  // the old one and a marker saying so, because a file this process has open
  // cannot be swapped underneath it. This is the only instant when nothing
  // holds it.
  const { applyPendingStoreRestore } = await import("./services/backup/store-swap");
  applyPendingStoreRestore();

  // An update that ended by killing this process cannot have reported its own
  // outcome. Reaching this line is the proof that it worked — the only way to
  // get here is a process that loaded the build the update swapped in — so this
  // is where the run is closed out. Before the store for the same reason as the
  // restore above: it is a plain file, and it has to be readable even when the
  // database is what the update broke.
  const { settlePanelUpdate, scheduleDistCleanup } = await import("./services/panel-update/state");
  const settled = settlePanelUpdate(env.dataDir);
  if (settled?.phase === "done" && settled.bootedAt) {
    console.log(
      `[RunPanel] Aggiornamento completato: ${settled.fromSha?.slice(0, 7)} → ${settled.toSha?.slice(0, 7)}`
    );
    if (settled.distBackup) scheduleDistCleanup(settled.distBackup);
  } else if (settled?.phase === "failed" && settled.error) {
    console.warn(`[RunPanel] Aggiornamento non completato: ${settled.error}`);
  }

  // Opening the store here also applies migrations and crash recovery up front,
  // so the first real request does not pay for it.
  const { getDb } = await import("./lib/db");
  await getDb();

  // A bind list that was being applied when this process stopped. Before the
  // schedulers and not behind their flag: it is correctness, not a chore. It
  // never resumes an application — see the function for why — but it does
  // rebuild a container that was removed and never recreated, which is the one
  // state no operator can get out of from the panel.
  const { reconcileMountApplies } = await import("./services/service-mounts");
  await reconcileMountApplies().catch((err) => {
    console.error("[mounts] Recovery failed:", err instanceof Error ? err.message : err);
  });

  // An unclaimed panel is a panel anyone can claim, and the first person to do
  // so gets a shell on this host. Print the token the setup form has to quote,
  // so claiming it requires reading this log rather than merely arriving first.
  const { isFirstRun } = await import("./lib/auth");
  if (await isFirstRun()) {
    const { getSetupToken } = await import("./lib/setup-token");
    console.log(
      `[RunPanel] Not set up yet. Enter this token on the setup screen:\n\n` +
        `    ${getSetupToken()}\n\n` +
        `    (a restart issues a new one; RUNPANEL_SETUP_TOKEN pins it)`
    );
  }

  // The data directory can outlive a container rebuild, and a missing auth file
  // shows up as an unexplained "pull access denied" rather than as an error.
  const { syncRegistryConfig } = await import("./services/docker/registry");
  const registries = await syncRegistryConfig();
  if (registries > 0) {
    console.log(`[RunPanel] Registry credentials restored for ${registries} registr${registries === 1 ? "y" : "ies"}`);
  }

  // The local destination has to exist before anything can be backed up to it.
  // Created here rather than in the migration: a migration that encrypted
  // anything would need a working key to apply, and the one moment you most
  // need a schema to apply is the moment something is wrong.
  const { ensureDefaultDestination } = await import("./services/backup/destinations");
  await ensureDefaultDestination();

  if (env.disableSchedulers) {
    console.log("[RunPanel] Timer di fondo disattivati (RUNPANEL_DISABLE_SCHEDULERS)");
    return;
  }

  // A restricted port is held open by this process and by nothing else, so
  // until this runs it is closed. Behind the same flag as the timers, and for
  // the same reason: it binds real host ports, which a throwaway instance next
  // to a real one must not do. The failure direction is a shut port, never an
  // open one.
  const { reconcileGates } = await import("./services/access");
  await reconcileGates();

  // Housekeeping on a timer, in addition to the per-project sweep after each
  // deploy: a project deleted while Docker was unreachable leaves resources
  // nothing else would ever come back for.
  const { startGcScheduler } = await import("./services/docker/gc");
  startGcScheduler();

  // Scheduled backups. Its first tick is also where a schedule missed while the
  // panel was down gets noticed.
  const { startBackupScheduler } = await import("./services/backup/scheduler");
  startBackupScheduler();

  // Auto-deploy for the projects that ask GitHub instead of waiting to be told.
  // Nothing to reconcile at boot: the poller reads the branch on its first tick
  // and compares, so a push made while the panel was down is picked up then.
  const { startDeployPoller } = await import("./services/deploy-poll");
  startDeployPoller();

  // The same question asked about the panel itself. It only ever *asks*: an
  // update is applied when somebody presses the button, never on a timer, since
  // nobody asks for the thing they are looking at to restart underneath them.
  const { startPanelUpdatePoller } = await import("./services/panel-update/check");
  startPanelUpdatePoller();

  // Docker reachability and free disk space, which are the two conditions
  // nothing else here watches over time — every other notification is a side
  // effect of something the panel was already doing.
  const { startNotifyWatch } = await import("./services/notify/watch");
  startNotifyWatch();

  /*
    "I am back."

    Delayed and never awaited, because it reaches the network and boot is not
    the place to wait on Telegram. It is also the only signal that catches a
    panel in a crash-loop: systemd restarts it every five seconds and nothing
    else would ever say so, since the panel that would have complained is the
    one that keeps dying.
  */
  const restartNotice = setTimeout(() => {
    void (async () => {
      try {
        const { notify } = await import("./services/notify");
        const { panelRelease } = await import("./services/panel-update/release");
        const release = await panelRelease();
        await notify({
          key: "panel.restarted",
          // The label rather than the bare semver: "v0.1.0" has been true since
          // the first commit, so on a phone it says nothing about which build
          // just came back.
          version: release.label.replace(/^v/, ""),
          sha: release.sha,
          afterUpdate: settled?.phase === "done" && Boolean(settled.bootedAt),
        });
      } catch {
        /* a notification is never a reason to make a boot noisy */
      }
    })();
  }, 15_000);
  restartNotice.unref?.();

  // Bring back whatever is marked to start at boot — after a delay, and without
  // being awaited: Docker is still restarting its own containers at this point,
  // and blocking here would delay the first request by a minute or more.
  const { startAutostartReconciler } = await import("./services/autostart/reconcile");
  startAutostartReconciler();

  // The status column records the last command the panel issued, so anything
  // that stops without going through the panel — a reboot, a crash, the panel
  // itself going down and taking its children with it — leaves a row claiming
  // to be running. This is what comes back to check.
  const { startStatusReconciler } = await import("./services/status-reconcile");
  startStatusReconciler();
}
