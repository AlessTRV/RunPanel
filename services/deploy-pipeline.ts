import { getDb, nowIso } from "@/lib/db";
import type { DeploymentsTable, ProjectsTable } from "@/lib/db/schema";
import { decrypt } from "@/lib/auth";
import { gitPull, gitClone, repoExists, getRepoPath, getLatestCommit } from "./git-manager";
import { buildProject } from "./builder-registry";
import { processManager } from "./process-manager";
import { runReleaseCommand, waitForHealthy } from "./deploy-steps";
import { writeEnvFile, writeEnvFileInto } from "./env-file";
import { readRepoContract, RUNPANEL_CONFIG_FILE } from "./deploy-presets";
import {
  parseContractJson,
  preflight,
  resolveContractJson,
  selectBuildEnv,
} from "@/lib/deploy-contract";
import {
  buildConnectionString,
  connectionEnvKey,
  serviceContainerName,
} from "./service-provisioner";
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
};

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
  const wasRunning = project.status === "running";
  const logFile = new BuildLogFile(deploymentId);

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
          fs.rmSync(fullPath, { recursive: true, force: true });
          appendLog(`Removed ${dir}/`);
        }
      }
    }

    // Source acquisition — deploy pulls from git, rebuild keeps local files
    const projectDir = getRepoPath(project.slug);

    if (mode === "deploy" && project.source_type === "github" && project.source_url) {
      appendLog("\n--- Fetching source ---");
      if (repoExists(project.slug)) {
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

    // A repository can declare its own deploy contract. Panel settings win —
    // the operator can see the target machine, the repository cannot.
    const repoContract = readRepoContract(projectDir);
    if (repoContract) {
      contract = resolveContractJson(project.builder_config, repoContract);
      appendLog(`Found ${RUNPANEL_CONFIG_FILE} in the repository — merged under the panel settings.`);
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

    const port = project.port ?? (project.runtime_type === "docker" ? 0 : 3000);
    if (port > 0) {
      envVars.PORT = port.toString();
    }
    if (!envVars.NODE_ENV) {
      envVars.NODE_ENV = "production";
    }

    // Auto-inject service connection URLs (DB, Redis, etc.)
    const linkedServices = await db
      .selectFrom("services")
      .select(["name", "type", "port", "credentials", "config"])
      .where("project_id", "=", project.id)
      .execute();

    const isDockerApp = project.runtime_type === "docker";
    for (const svc of linkedServices) {
      let containerName = "";
      try {
        containerName =
          (JSON.parse(svc.config || "{}") as { containerName?: string }).containerName ?? "";
      } catch { /* fall through to the derived name */ }
      if (!containerName) containerName = serviceContainerName(svc.name);

      // A containerised app reaches the service by container name over the
      // shared project network; a native process reaches it on localhost.
      const host = isDockerApp ? containerName : "localhost";
      let creds: { user?: string; password?: string; database?: string } = {};
      try {
        creds = JSON.parse(decrypt(svc.credentials));
      } catch { /* credentials unreadable — fall back to an empty URL */ }

      const envKey = connectionEnvKey(svc.type);

      // Don't overwrite if the user already set it
      if (!envVars[envKey]) {
        envVars[envKey] = buildConnectionString(svc.type, {
          host,
          port: svc.port,
          user: creds.user,
          password: creds.password,
          database: creds.database,
        });
        appendLog(`Auto-linked ${svc.type} service "${svc.name}" → ${envKey}`);
      }
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

    // Materialise a .env file when the app reads one itself.
    if (contract.envFile.enabled) {
      if (isDockerApp) {
        const hostPath = writeEnvFile(project.slug, envVars);
        appendLog(`Wrote env file for mounting at ${contract.envFile.path}`);
        contract.docker.mounts = [
          ...contract.docker.mounts,
          `${hostPath}:${contract.envFile.path}:ro`,
        ];
      } else {
        const written = writeEnvFileInto(projectDir, contract.envFile.path, envVars);
        appendLog(`Wrote env file to ${path.relative(projectDir, written)}`);
      }
    }

    // Build (install + compile) — the old process stays up during this phase
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

    // Stop the old process only after the build succeeded
    if (wasRunning && mode === "deploy") {
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
    await processManager.start(project.slug, buildResult.startCmd, project.runtime_type, {
      cwd: buildResult.artifactDir,
      env: envVars,
      port,
      deploymentId,
      onLog: appendLog,
      restartPolicy: contract.runtime.restartPolicy,
      network: contract.docker.network,
      hostname: contract.docker.hostname,
      capAdd: contract.docker.capAdd,
      extraHosts: contract.docker.extraHosts,
      mounts: contract.docker.mounts,
      memory: contract.runtime.memory,
      cpus: contract.runtime.cpus,
      shmSize: contract.runtime.shmSize,
    });

    appendLog("\n--- Health check ---");
    const health = await waitForHealthy({
      slug: project.slug,
      runtimeType: project.runtime_type,
      port,
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

    // If it had been running and we took it down, that is an error state.
    // If it was already stopped, leave it stopped.
    await db
      .updateTable("projects")
      .set({ status: wasRunning ? "error" : "stopped", updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();
  } finally {
    logFile.flush();
  }
}
