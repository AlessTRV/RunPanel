import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";
import { detectPackageManager } from "../package-manager";
import fs from "fs";
import path from "path";

export const nodeBuilder: IBuilder = {
  name: "node",

  async detect(projectDir: string): Promise<boolean> {
    return fs.existsSync(path.join(projectDir, "package.json"));
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, buildCmd, startCmd, installCmd, packageManager, envVars, onLog } = ctx;
    // A rejection from `onPhase` lands in the catch below and comes back as a
    // build failure rather than as an exception. That is fine: its message
    // already names the command, and the row's lifecycle was settled before it
    // threw — see `runPhase`.
    const pm = packageManager && packageManager !== "auto"
      ? { cmd: packageManager, install: `${packageManager} install` }
      : detectPackageManager(projectDir);

    try {
      await ctx.onPhase?.("pre-install");

      // Install dependencies — multi-line custom or auto-detected
      if (installCmd) {
        const cmds = installCmd.split("\n").map(c => c.trim()).filter(Boolean);
        const joined = cmds.join(" && ");
        onLog(cmds.map(c => `> ${c}`).join("\n"));
        await runCommand(joined, { cwd: projectDir, env: envVars, onLog });
      } else {
        onLog(`> ${pm.install}`);
        await runCommand(pm.install, { cwd: projectDir, env: envVars, onLog });
      }
      onLog("Dependencies installed.");

      await ctx.onPhase?.("post-install");

      // Build — multi-line custom or auto-detected
      const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
      const hasBuildScript = pkgJson.scripts?.build;

      if (buildCmd) {
        const cmds = buildCmd.split("\n").map(c => c.trim()).filter(Boolean);
        const joined = cmds.join(" && ");
        onLog(cmds.map(c => `> ${c}`).join("\n"));
        await runCommand(joined, { cwd: projectDir, env: envVars, onLog });
        onLog("Build completed.");
      } else if (hasBuildScript) {
        const cmd = `${pm.cmd} run build`;
        onLog(`> ${cmd}`);
        await runCommand(cmd, { cwd: projectDir, env: envVars, onLog });
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
