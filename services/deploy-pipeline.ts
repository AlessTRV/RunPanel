import { getDb, nowIso } from "@/lib/db";
import type { DeploymentsTable, ProjectsTable } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import {
  gitPull,
  gitClone,
  gitCheckoutCommit,
  repoExists,
  getRepoPath,
  getLatestCommit,
} from "./git-manager";
import { buildProject } from "./builder-registry";
import { processManager } from "./process-manager";
import { isWindows } from "./env-utils";
import { runReleaseCommand, waitForHealthy } from "./deploy-steps";
import { writeEnvFileInto } from "./env-file";
import { buildStartOpts } from "./start-opts";
import { detectPreset, readRepoContract, RUNPANEL_CONFIG_FILE } from "./deploy-presets";
import {
  parseContractJson,
  preflight,
  resolveContract,
  resolveContractJson,
  selectBuildEnv,
  stripPanelOnlyFields,
} from "@/lib/deploy-contract";
import { checkLoopbackLeak, listenPort, readAccess, syncGate } from "./access";
import { closeGate } from "./access-gate";
import { injectLinkedServiceEnv } from "./service-injection";
import { sweep } from "./docker/gc";
import { BuildLogFile } from "./build-logs";
import { projectEvents } from "./events";
import path from "path";
import fs from "fs";

type Project = ProjectsTable;

interface DeployOptions {
  onLog?: (line: string) => void;
  mode?: "deploy" | "rebuild";
}

/** Directories wiped by a rebuild, by runtime. */
const REBUILD_CLEAN_DIRS: Record<string, string[]> = {
  node: [".next", "node_modules", "dist", "build", ".turbo"],
  static: ["dist", "build"],
  custom: ["venv", "__pycache__", "dist", "build"],
  docker: [],
  compose: [],
};

/**
 * Runtimes whose build writes into the same directory the app runs from.
 *
 * Docker and Compose build an image instead, so a running container holds
 * nothing on the host and the old instance can stay up through the build.
 */
const IN_PLACE_BUILD_RUNTIMES = new Set(["node", "static", "custom"]);

/**
 * Deploys are started with `void executeDeploy(...)` — nothing awaits them, so
 * this must never reject. An unhandled rejection here would take down the whole
 * panel, not just the deploy.
 */
export async function executeDeploy(
  project: Project,
  deploymentId: string,
  opts: DeployOptions = {}
): Promise<void> {
  try {
    await runDeploy(project, deploymentId, opts);
  } catch (err) {
    // Only reachable if the store itself is unavailable — runDeploy handles
    // every failure it can still record.
    console.error(`[deploy] Unrecoverable error for deployment ${deploymentId}:`, err);
  }
}

async function runDeploy(
  project: Project,
  deploymentId: string,
  opts: DeployOptions
): Promise<void> {
  const db = await getDb();
  const externalLog = opts.onLog;
  const mode = opts.mode ?? "deploy";
  const logFile = new BuildLogFile(deploymentId);

  // The row is a record of intent, and it drifts from reality: a deploy that
  // starts the app and then fails its health check records "error"/"stopped"
  // while the process it started is still online. Only the driver knows what is
  // running — but asking costs a pm2 spawn, so it is asked only where believing
  // the row actually breaks something.
  //
  // That is Windows. There, a rebuild that skips its stop then walks into
  // `rm -rf node_modules` and cannot remove a directory holding a mapped native
  // addon:
  //
  //   EPERM, Permission denied: …\data\repos\spanel\node_modules
  //
  // Elsewhere an open file is no obstacle to unlinking it, so a stale row costs
  // at most a stop that no-ops — not worth a spawn on every deploy.
  let wasRunning = project.status === "running";
  if (isWindows) {
    try {
      wasRunning = (await processManager.status(project.slug, project.runtime_type)).running;
    } catch {
      /* a driver that cannot answer leaves the row's opinion standing */
    }
  }

  // Resolved once the source is on disk, so an in-repo `runpanel.json` can take
  // part. Until then, the panel's settings alone.
  let contract = parseContractJson(project.builder_config);

  async function updateDeployment(fields: Partial<DeploymentsTable>) {
    await db.updateTable("deployments").set(fields).where("id", "=", deploymentId).execute();
    if (fields.status) {
      projectEvents.emit(project.id, {
        type: "deploy:status",
        deploymentId,
        status: fields.status,
        message: fields.error_message ?? undefined,
      });
    }
  }

  /**
   * One call sends a line three places: the optional in-process callback, the
   * on-disk log, and every browser watching this project. Publishing here is
   * what makes a deploy visible while it happens rather than only afterwards.
   */
  function appendLog(line: string) {
    externalLog?.(line);
    logFile.append(line);
    projectEvents.emit(project.id, { type: "deploy:log", deploymentId, line });
  }

  const label = mode === "rebuild" ? "Re-Build" : "Deploy";

  try {
    await updateDeployment({ status: "building" });
    appendLog(`=== ${label} started ===`);

    // REBUILD only: stop + clean first
    if (mode === "rebuild") {
      if (wasRunning) {
        appendLog("--- Stopping process for clean rebuild ---");
        try {
          await processManager.stop(project.slug, project.runtime_type);
          appendLog("Process stopped.");
        } catch {
          appendLog("No process to stop.");
        }
      }

      appendLog("\n--- Cleaning build artifacts ---");
      const cleanDir = getRepoPath(project.slug);
      for (const dir of REBUILD_CLEAN_DIRS[project.runtime_type] ?? []) {
        const fullPath = path.join(cleanDir, dir);
        if (fs.existsSync(fullPath)) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (err: unknown) {
            // Windows only: there EPERM/EBUSY on a directory means something
            // has it open, and `force: true` does not help — raw, the error
            // reads as a permissions problem and sends you to check ACLs. On
            // POSIX the same codes really are about permissions, so rewriting
            // the message there would only mislead.
            const code = (err as NodeJS.ErrnoException).code;
            if (isWindows && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
              throw new Error(
                `Cannot remove ${dir}/: a process still has it open. ` +
                  `On Windows a running app locks its native modules, so stop anything ` +
                  `using ${cleanDir} — including editors and terminals — and retry.`
              );
            }
            throw err;
          }
          appendLog(`Removed ${dir}/`);
        }
      }
    }

    // Source acquisition — deploy pulls from git, rebuild keeps local files
    const projectDir = getRepoPath(project.slug);

    if (mode === "deploy" && project.source_type === "github" && project.source_url) {
      appendLog("\n--- Fetching source ---");
      if (project.pinned_sha) {
        /*
          The project is held at a commit, so that is what gets built — not the
          head of the branch.

          The row is fresh: the queue re-reads it inside `claim()` before every
          run, including the coalesced follow-up. That is why the pin does not
          need to travel through the request; a webhook delivery that slipped
          through the suspension check would land here and build the pinned
          commit, which is the right outcome rather than a race to lose.
        */
        appendLog(`Restoring commit ${project.pinned_sha.slice(0, 7)} from ${project.source_branch}...`);
        const commit = await gitCheckoutCommit(
          project.slug,
          project.source_branch,
          project.pinned_sha,
          { repoUrl: project.source_url, onLog: appendLog }
        );
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      } else if (repoExists(project.slug)) {
        appendLog(`Pulling latest from ${project.source_branch}...`);
        const commit = await gitPull(project.slug, project.source_branch);
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      } else {
        appendLog(`Cloning ${project.source_url}...`);
        await gitClone(project.source_url, project.source_branch, project.slug);
        const commit = await getLatestCommit(project.slug);
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Cloned at: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      }
    }

    // A project whose source was never fetched has no directory on disk, and
    // every step from here on would run against a path that is not there. On
    // Windows that surfaces as `spawn cmd.exe ENOENT` — an error that points at
    // the shell instead of the cause — so say what is actually missing.
    if (!fs.existsSync(projectDir)) {
      throw new Error(
        project.source_type === "github" && !project.source_url
          ? "No repository configured. Open the project's Source settings, set a GitHub URL, then deploy."
          : "No source on disk for this project. Connect a GitHub repository or upload a ZIP, then deploy."
      );
    }

    // Now that the source is on disk, work out the rest of the contract.
    //
    // Precedence, lowest first: a preset detected from the repository's shape,
    // then the repository's own runpanel.json, then whatever the operator set.
    // The detected preset is what lets a project with no configuration at all
    // deploy anyway.
    // The repository's contract is untrusted input: it arrives with whatever
    // was pushed. Strip the fields that would let it reach outside its own
    // container before it takes part in the merge at all.
    const rawRepoContract = readRepoContract(projectDir);
    const stripped = rawRepoContract === null ? null : stripPanelOnlyFields(rawRepoContract);
    const repoContract = stripped?.contract ?? null;
    const preset = detectPreset(projectDir);

    if (preset) {
      appendLog(`Detected project shape: ${preset.label}`);
    }

    if (preset || repoContract) {
      const layers = [preset?.contract, repoContract].filter(Boolean);
      let base: unknown = {};
      for (const layer of layers) base = resolveContract(layer as object, base);
      contract = resolveContractJson(project.builder_config, base);

      if (repoContract) {
        appendLog(`Found ${RUNPANEL_CONFIG_FILE} in the repository — merged under the panel settings.`);
      }
      if (stripped && stripped.rejected.length > 0) {
        appendLog(
          `Ignored ${stripped.rejected.join(", ")} from ${RUNPANEL_CONFIG_FILE}: ` +
            `these grant access to the host and can only be set from the panel.`
        );
      }
    }

    // Load env vars
    const envRows = await db
      .selectFrom("env_vars")
      .select(["key", "value"])
      .where("project_id", "=", project.id)
      .execute();

    appendLog(`Loaded ${envRows.length} env var(s)`);

    const envVars: Record<string, string> = {};
    for (const row of envRows) {
      envVars[row.key] = decrypt(row.value);
    }

    // Container runtimes publish whatever their own definition says, so an
    // unset port means "no HTTP probe" rather than "assume 3000".
    const isContainerRuntime = project.runtime_type === "docker" || project.runtime_type === "compose";
    const port = project.port ?? (isContainerRuntime ? 0 : 3000);
    if (port > 0) {
      envVars.PORT = port.toString();
    }
    if (!envVars.NODE_ENV) {
      envVars.NODE_ENV = "production";
    }

    const isDockerApp = project.runtime_type === "docker";

    // Auto-inject service connection URLs (DB, Redis, etc.).
    //
    // Shared with `restartFromLastDeployment`, which has to produce the same
    // environment: see `services/service-injection.ts` for why they used to
    // differ and what that cost. The rule itself lives in `lib/service-env.ts`
    // as a pure function, so the whole on/off × key-already-defined matrix is
    // testable without a daemon.
    const { applied, skipped, conflicts } = await injectLinkedServiceEnv(
      project,
      contract.docker.network,
      envVars
    );

    for (const injection of applied) {
      appendLog(
        injection.replaced
          ? `Servizio "${injection.service}" → ${injection.key}: sostituisce il valore definito sul progetto.`
          : `Servizio "${injection.service}" → ${injection.key}`
      );
    }
    for (const name of skipped) {
      appendLog(`Servizio "${name}": iniezione disattivata, il progetto usa le proprie variabili.`);
    }
    for (const conflict of conflicts) {
      // Reported rather than resolved by row order, which is how the second
      // database of a pair used to disappear without anyone being told.
      appendLog(
        `ATTENZIONE: ${conflict.services.join(", ")} vogliono tutti ${conflict.key}. ` +
          `Vale il primo (${conflict.services[0]}); cambia la variabile degli altri per usarli.`
      );
    }

    // Fail fast on anything knowable before a build that may run for minutes.
    const issues = preflight(contract, { runtimeType: project.runtime_type, envVars });
    if (issues.length > 0) {
      appendLog("\n--- Preflight ---");
      for (const issue of issues) appendLog(`[warn] ${issue.field}: ${issue.message}`);
    }

    // Values a frontend build inlines into its client bundle have to exist at
    // BUILD time. Supplying them only at runtime either ships the wrong value
    // or fails a Dockerfile that asserts on them.
    const buildEnv = selectBuildEnv(contract, envVars);
    if (Object.keys(buildEnv).length > 0) {
      appendLog(`Build-time variables: ${Object.keys(buildEnv).sort().join(", ")}`);
    }

    // Materialise a .env file when the app reads one itself. The container case
    // is handled by `buildStartOpts`, which writes the file and adds the mount
    // together — appending it to the contract here left it out of every restart,
    // because a restart re-reads the contract from the row and this never wrote
    // it back.
    if (contract.envFile.enabled && !isDockerApp) {
      const written = writeEnvFileInto(projectDir, contract.envFile.path, envVars);
      appendLog(`Wrote env file to ${path.relative(projectDir, written)}`);
    }

    // Windows cannot replace a file that a running process has mapped, and a
    // native addon is always mapped — Prisma's query engine, better-sqlite3,
    // sharp. Since an in-place build writes into the very node_modules the old
    // instance is executing from, leaving it up does not buy zero downtime, it
    // costs the whole deploy: `prisma generate` dies with
    //
    //   EPERM: operation not permitted, rename
    //   '…/.prisma/client/query_engine-windows.dll.node.tmp3776' -> '….node'
    //
    // and every subsequent deploy of a Prisma project fails the same way, for
    // as long as the app is up. Real zero-downtime here needs a separate build
    // directory, not a later stop. Placed after preflight so a deploy that was
    // never going to run does not take the app down on its way out.
    let stoppedForBuild = false;
    if (
      isWindows &&
      wasRunning &&
      mode === "deploy" &&
      IN_PLACE_BUILD_RUNTIMES.has(project.runtime_type)
    ) {
      appendLog("\n--- Stopping previous instance ---");
      appendLog("Windows: the build writes into the directory it runs from.");
      try {
        await processManager.stop(project.slug, project.runtime_type);
        appendLog("Previous instance stopped.");
      } catch {
        appendLog("No previous instance to stop.");
      }
      stoppedForBuild = true;
    }

    // Build (install + compile). Everywhere else the old process stays up for
    // this phase; see above for why Windows cannot.
    appendLog("\n--- Building ---");

    const buildResult = await buildProject(projectDir, project.runtime_type, {
      slug: project.slug,
      deploymentId,
      buildCmd: contract.commands.build,
      startCmd: contract.commands.start,
      installCmd: contract.commands.install,
      packageManager: contract.packageManager,
      dockerImage: contract.docker.image,
      dockerfile: contract.docker.dockerfile,
      buildContext: contract.docker.context,
      target: contract.docker.target,
      buildArgs: buildEnv,
      buildTimeout: contract.build.timeoutSec * 1000,
      // Build-time env for native runtimes, plus any Node heap override.
      envVars: {
        ...envVars,
        ...buildEnv,
        ...(contract.build.nodeOptions ? { NODE_OPTIONS: contract.build.nodeOptions } : {}),
      },
      onLog: appendLog,
    });

    if (!buildResult.success) {
      throw new Error(buildResult.error || "Build failed");
    }

    // Release command: one-shot work that must happen after the build and
    // before the app serves traffic — migrations, schema push, cache warm.
    if (contract.commands.release) {
      appendLog("\n--- Release ---");
      await runReleaseCommand(contract.commands.release, {
        runtimeType: project.runtime_type,
        slug: project.slug,
        projectDir: buildResult.artifactDir,
        image: buildResult.startCmd.replace(/^docker:/, ""),
        env: envVars,
        contract,
        onLog: appendLog,
      });
      appendLog("Release command completed.");
    }

    await updateDeployment({
      start_cmd: buildResult.startCmd,
      artifact_dir: buildResult.artifactDir,
    });

    // Stop the old process only after the build succeeded — unless the build
    // itself already required it down.
    if (wasRunning && mode === "deploy" && !stoppedForBuild) {
      appendLog("\n--- Stopping previous instance ---");
      try {
        await processManager.stop(project.slug, project.runtime_type);
        appendLog("Previous instance stopped.");
      } catch {
        appendLog("No previous instance to stop.");
      }
    }

    // Start new process
    appendLog("\n--- Starting application ---");
    // Announced before the start, not after: the driver empties the output as
    // its first act, and a viewer told afterwards would clear the lines the new
    // run has already printed.
    projectEvents.emit(project.id, { type: "process:reset" });

    // A restricted project listens on loopback with the panel's gate in front,
    // so the gate has to let the public port go before the app can be started
    // on it, and take it back afterwards. `access.port` is null when open, and
    // then none of this happens.
    const access = readAccess(project);
    const restricted = access.mode === "restricted" && access.port !== null;
    if (restricted) await closeGate("project", project.id);
    // Everything downstream — the health probe included — has to look at where
    // the app really is, not where its callers reach it.
    const listenOn = restricted ? listenPort(project, port) : port;

    await processManager.start(
      project.slug,
      buildResult.startCmd,
      project.runtime_type,
      buildStartOpts({
        project,
        contract,
        envVars,
        cwd: buildResult.artifactDir,
        port,
        loopbackPort: restricted ? listenOn : undefined,
        deploymentId,
        onLog: appendLog,
      })
    );

    if (restricted) {
      try {
        await syncGate("project", project.id, project, { publicPort: project.port, label: project.name });
        appendLog(`Accesso limitato: porta ${project.port} filtrata dal pannello.`);
        // Whether the app honoured the loopback bind is checked, not assumed.
        // Not awaited: the answer is a notice on a page, not a deploy step.
        void checkLoopbackLeak(project.id, listenOn);
      } catch (err) {
        // Said out loud rather than swallowed: from the outside a gate that did
        // not open and a restriction working perfectly look identical.
        appendLog(`ATTENZIONE: la porta ${project.port} non è stata aperta — ${(err as Error).message}`);
      }
    }

    appendLog("\n--- Health check ---");
    const health = await waitForHealthy({
      slug: project.slug,
      runtimeType: project.runtime_type,
      port: listenOn,
      contract,
      onLog: appendLog,
    });

    if (!health.healthy) {
      const driverName = project.runtime_type === "docker" ? "Docker" : "PM2";
      appendLog(`\n--- ${driverName} process logs ---`);
      try {
        const recentLogs = await processManager.logs(project.slug, project.runtime_type, 40);
        if (recentLogs.length > 0) {
          for (const line of recentLogs) appendLog(line);
        } else {
          appendLog(`(no ${driverName} logs available)`);
        }
      } catch {
        appendLog(`(failed to retrieve ${driverName} logs)`);
      }
      throw new Error(
        `Health check failed after ${contract.healthcheck.timeoutSec}s: ${health.reason}`
      );
    }

    // Finalize
    appendLog(`\n=== ${label} successful ===`);
    logFile.flush();

    await updateDeployment({ status: "running", finished_at: nowIso() });

    await db
      .updateTable("deployments")
      .set({ status: "superseded" })
      .where("project_id", "=", project.id)
      .where("id", "!=", deploymentId)
      .where("status", "=", "running")
      .execute();

    await db
      .updateTable("projects")
      .set({ status: "running", port, updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();

    // Retire images this project no longer needs. Scoped to the project and run
    // after success, so a failed deploy never destroys the image that is still
    // serving traffic. Orphans are left alone — those need a human decision.
    if (project.runtime_type === "docker") {
      try {
        const result = await sweep({ project: project.slug });
        if (result.prunedImageTags.length > 0) {
          console.log(
            `[deploy] Retired ${result.prunedImageTags.length} old image(s) for ${project.slug}`
          );
        }
      } catch (err) {
        console.error("[deploy] Image cleanup failed:", err);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Deploy failed";
    const stack = err instanceof Error ? err.stack : undefined;
    appendLog(`\n=== ${label} FAILED: ${message} ===`);
    if (stack) appendLog(`Stack: ${stack}`);
    logFile.flush();

    await updateDeployment({
      status: "failed",
      error_message: message,
      finished_at: nowIso(),
    });

    // Record what is actually up, not what was up when the deploy began: a
    // health check failure arrives with the new process already started, so the
    // opening snapshot is what let the row say "stopped" about a live app.
    // Windows only, for the same reason as above — it is the platform where the
    // next rebuild is then unable to clean the directory that app is holding.
    let stillRunning = wasRunning;
    if (isWindows) {
      try {
        stillRunning = (await processManager.status(project.slug, project.runtime_type)).running;
      } catch {
        /* a driver that cannot answer leaves the opening snapshot standing */
      }
    }

    // Running after a failed deploy is an error state — it is serving, but not
    // what this deploy intended. Not running is simply stopped.
    await db
      .updateTable("projects")
      .set({ status: stillRunning ? "error" : "stopped", updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();
  } finally {
    logFile.flush();
  }
}
