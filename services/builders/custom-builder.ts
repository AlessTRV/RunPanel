import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";
import fs from "fs";
import path from "path";

export const customBuilder: IBuilder = {
  name: "custom",

  async detect(): Promise<boolean> {
    // Custom builder never auto-detects — must be explicitly chosen
    return false;
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, buildCmd, startCmd, installCmd, envVars, onLog } = ctx;

    if (!startCmd) {
      return {
        success: false,
        artifactDir: projectDir,
        startCmd: "",
        error: "Start command is required for custom runtime. Configure it in project settings.",
      };
    }

    try {
      // Install — join all lines with && so they run in the same shell session
      // (needed for venv activation to persist across commands)
      if (installCmd) {
        const cmds = installCmd.split("\n").map(c => c.trim()).filter(Boolean);
        const joined = cmds.join(" && ");
        onLog(cmds.map(c => `> ${c}`).join("\n"));
        await runCommand(joined, { cwd: projectDir, env: envVars, onLog });
        onLog("Install completed.");
      }

      // Build — same: single shell session
      if (buildCmd) {
        const cmds = buildCmd.split("\n").map(c => c.trim()).filter(Boolean);
        const joined = cmds.join(" && ");
        onLog(cmds.map(c => `> ${c}`).join("\n"));
        await runCommand(joined, { cwd: projectDir, env: envVars, onLog });
        onLog("Build completed.");
      }

      // Start — only the first non-empty line is the start command
      let resolvedStart = startCmd.split("\n").map(c => c.trim()).filter(Boolean)[0];

      // If a venv exists, check if the start command's binary (python3, gunicorn, uvicorn, etc.)
      // is available in venv/bin/ and resolve to its absolute path.
      // PM2 uses execFile which doesn't activate the venv, so the binary must be explicit.
      const venvBin = path.join(projectDir, "venv", "bin");
      if (fs.existsSync(venvBin)) {
        const parts = resolvedStart.split(/\s+/);
        const binary = parts[0];
        // Only resolve bare command names (not absolute/relative paths)
        if (binary && !binary.includes("/")) {
          const venvBinary = path.join(venvBin, binary);
          if (fs.existsSync(venvBinary)) {
            parts[0] = venvBinary;
            resolvedStart = parts.join(" ");
            onLog(`Resolved "${binary}" to venv: ${venvBinary}`);
          }
        }
      }

      onLog(`Start command: ${resolvedStart}`);

      return {
        success: true,
        artifactDir: projectDir,
        startCmd: resolvedStart,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
