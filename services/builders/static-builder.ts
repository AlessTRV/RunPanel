import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";
import fs from "fs";
import path from "path";

export const staticBuilder: IBuilder = {
  name: "static",

  async detect(projectDir: string): Promise<boolean> {
    return fs.existsSync(path.join(projectDir, "index.html"));
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, buildCmd, envVars, onLog } = ctx;

    try {
      // Run optional build command
      if (buildCmd) {
        onLog(`> ${buildCmd}`);
        await runCommand(buildCmd, { cwd: projectDir, env: envVars, timeout: 120_000, onLog });
        onLog("Build completed.");
      }

      // Determine artifact directory
      let artifactDir = projectDir;
      const possibleDirs = ["dist", "build", "public", "out"];
      for (const dir of possibleDirs) {
        const p = path.join(projectDir, dir);
        if (fs.existsSync(p) && fs.existsSync(path.join(p, "index.html"))) {
          artifactDir = p;
          break;
        }
      }

      onLog(`Serving from: ${artifactDir}`);

      return {
        success: true,
        artifactDir,
        startCmd: `npx serve -s "${artifactDir}" -l`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
