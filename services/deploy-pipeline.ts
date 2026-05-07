import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth";
import { config } from "@/lib/config";
import { gitPull, gitClone, repoExists, getRepoPath } from "./git-manager";
import { buildProject } from "./builder-registry";
import { processManager } from "./process-manager";
import type { BuildContext } from "./builders/types";
import path from "path";
import fs from "fs";

interface Project {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  builder_config: string;
  port: number | null;
  status: string;
}

interface DeployOptions {
  onLog?: (line: string) => void;
  mode?: "deploy" | "rebuild";
}

export async function executeDeploy(
  project: Project,
  deploymentId: string,
  opts: DeployOptions = {}
): Promise<void> {
  const db = getDb();
  const log = opts.onLog || (() => {});
  const mode = opts.mode || "deploy";
  const wasRunning = project.status === "running";

  let builderConfig: Record<string, string | undefined> = {};
  try {
    builderConfig = JSON.parse(project.builder_config || "{}");
  } catch {
    builderConfig = {};
  }

  function updateDeployment(fields: Record<string, unknown>) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    const values = Object.values(fields);
    db.prepare(`UPDATE deployments SET ${sets} WHERE id = ?`).run(...values, deploymentId);
  }

  function appendLog(line: string) {
    log(line);
    db.prepare("UPDATE deployments SET build_log = build_log || ? WHERE id = ?")
      .run(line + "\n", deploymentId);
  }

  function nowTimestamp() {
    return new Date().toISOString().replace("T", " ").replace("Z", "").split(".")[0];
  }

  try {
    updateDeployment({ status: "building" });
    appendLog(`=== ${mode === "rebuild" ? "Re-Build" : "Deploy"} started ===`);

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
      const dirsToClean = [".next", "node_modules", "dist", "build", ".turbo", "venv", "__pycache__"];
      for (const dir of dirsToClean) {
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
        updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      } else {
        appendLog(`Cloning ${project.source_url}...`);
        await gitClone(project.source_url, project.source_branch, project.slug);
        const { default: commitInfo } = await import("./git-manager").then(m => ({ default: m.getLatestCommit }));
        const commit = await commitInfo(project.slug);
        updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Cloned at: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      }
    }

    // Load env vars
    const envRows = db.prepare(
      "SELECT key, value FROM env_vars WHERE project_id = ?"
    ).all(project.id) as { key: string; value: string }[];

    const envVars: Record<string, string> = {};
    for (const row of envRows) {
      envVars[row.key] = decrypt(row.value);
    }

    const port = project.port || (project.runtime_type === "docker" ? 0 : 3000);
    if (port > 0) {
      envVars.PORT = port.toString();
    }
    if (!envVars.NODE_ENV) {
      envVars.NODE_ENV = "production";
    }

    // Build (install + compile) — process stays running during this phase
    appendLog("\n--- Building ---");

    const buildResult = await buildProject(projectDir, project.runtime_type, {
      buildCmd: builderConfig.buildCmd,
      startCmd: builderConfig.startCmd,
      installCmd: builderConfig.installCmd,
      packageManager: builderConfig.packageManager as BuildContext["packageManager"],
      dockerImage: builderConfig.dockerImage as string | undefined,
      dockerTemplate: builderConfig.dockerTemplate as string | undefined,
      dockerFields: builderConfig.dockerFields as Record<string, string> | undefined,
      envVars,
      onLog: appendLog,
    });

    if (!buildResult.success) {
      throw new Error(buildResult.error || "Build failed");
    }

    updateDeployment({
      start_cmd: buildResult.startCmd,
      artifact_dir: buildResult.artifactDir,
    });

    // Stop old process AFTER build succeeded (deploy keeps it alive during build)
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
      onLog: appendLog,
    });

    // Health check (wait up to 15s for process + port binding)
    appendLog("Waiting for process to start...");
    let healthy = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const info = await processManager.status(project.slug, project.runtime_type);
      if (!info.running) {
        if (i % 3 === 2) appendLog(`Process not yet running (attempt ${i + 1}/15)...`);
        continue;
      }

      // Docker without explicit port — just check container is running
      if (port === 0) {
        healthy = true;
        appendLog(`Container running (${info.containerId || "N/A"}).`);
        break;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        await fetch(`http://127.0.0.1:${port}`, { signal: controller.signal });
        clearTimeout(timeout);
        healthy = true;
        appendLog(`Process running (PID: ${info.pid || "N/A"}) — port ${port} responding.`);
        break;
      } catch {
        if (i >= 5) {
          const recheck = await processManager.status(project.slug, project.runtime_type);
          if (!recheck.running) {
            appendLog("Process exited before port became available.");
            break;
          }
        }
        appendLog(`Port ${port} not yet responding (attempt ${i + 1}/15)...`);
      }
    }

    if (!healthy) {
      appendLog("\n--- PM2 process logs ---");
      try {
        const pm2Logs = await processManager.logs(project.slug, project.runtime_type, 30);
        if (pm2Logs.length > 0) {
          for (const line of pm2Logs) appendLog(line);
        } else {
          appendLog("(no PM2 logs available)");
        }
      } catch {
        appendLog("(failed to retrieve PM2 logs)");
      }
      throw new Error(`Process failed to start or port ${port} not responding within 15 seconds`);
    }

    // Finalize
    appendLog(`\n=== ${mode === "rebuild" ? "Re-Build" : "Deploy"} successful ===`);
    updateDeployment({ status: "running", finished_at: nowTimestamp() });

    db.prepare(`
      UPDATE deployments SET status = 'superseded'
      WHERE project_id = ? AND id != ? AND status = 'running'
    `).run(project.id, deploymentId);

    db.prepare("UPDATE projects SET status = 'running', port = ?, updated_at = datetime('now') WHERE id = ?")
      .run(port, project.id);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Deploy failed";
    const stack = err instanceof Error ? err.stack : undefined;
    appendLog(`\n=== ${mode === "rebuild" ? "Re-Build" : "Deploy"} FAILED: ${message} ===`);
    if (stack) appendLog(`Stack: ${stack}`);

    updateDeployment({
      status: "failed",
      error_message: message,
      finished_at: nowTimestamp(),
    });

    // If the project was running and we stopped it during the process, mark as error
    // If it was stopped/error before, keep that status
    if (wasRunning) {
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?")
        .run(project.id);
    } else {
      db.prepare("UPDATE projects SET status = 'stopped', updated_at = datetime('now') WHERE id = ?")
        .run(project.id);
    }
  }
}
