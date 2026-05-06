import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";
import fs from "fs";
import path from "path";

function detectPackageManager(projectDir: string): { cmd: string; install: string } {
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", install: "pnpm install" };
  }
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) {
    return { cmd: "yarn", install: "yarn install" };
  }
  if (fs.existsSync(path.join(projectDir, "bun.lock")) || fs.existsSync(path.join(projectDir, "bun.lockb"))) {
    return { cmd: "bun", install: "bun install" };
  }
  return { cmd: "npm", install: "npm install" };
}

export const nodeBuilder: IBuilder = {
  name: "node",

  async detect(projectDir: string): Promise<boolean> {
    return fs.existsSync(path.join(projectDir, "package.json"));
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, buildCmd, startCmd, installCmd, packageManager, envVars, onLog } = ctx;
    const pm = packageManager && packageManager !== "auto"
      ? { cmd: packageManager, install: `${packageManager} install` }
      : detectPackageManager(projectDir);

    try {
      // Install dependencies
      const installCommand = installCmd || pm.install;
      onLog(`> ${installCommand}`);
      await runCommand(installCommand, { cwd: projectDir, env: envVars, onLog });
      onLog("Dependencies installed.");

      // Build (if build script exists or custom build command provided)
      const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
      const hasBuildScript = pkgJson.scripts?.build;
      const buildCommand = buildCmd || (hasBuildScript ? `${pm.cmd} run build` : null);

      if (buildCommand) {
        onLog(`> ${buildCommand}`);
        await runCommand(buildCommand, { cwd: projectDir, env: envVars, onLog });
        onLog("Build completed.");
      }

      // Resolve start command
      let resolvedStartCmd = startCmd;
      if (!resolvedStartCmd) {
        if (pkgJson.scripts?.start) {
          resolvedStartCmd = `${pm.cmd} run start`;
        } else if (pkgJson.main) {
          resolvedStartCmd = `node ${pkgJson.main}`;
        } else {
          resolvedStartCmd = "node index.js";
        }
      }

      onLog(`Start command: ${resolvedStartCmd}`);

      return {
        success: true,
        artifactDir: projectDir,
        startCmd: resolvedStartCmd,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
