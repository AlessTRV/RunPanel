import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";

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
      const resolvedStart = startCmd.split("\n").map(c => c.trim()).filter(Boolean)[0];
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
