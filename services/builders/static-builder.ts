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
      /*
        Adjacent rather than wrapped around an install, because a static
        project has no install step to wrap. The two points still exist for a
        command that has to prepare the machine before the build —
        `apt-get install imagemagick` is exactly the case — and
        `phaseUnavailableReason` leaves them available for this runtime on
        purpose. A rejection surfaces as a build failure through the catch
        below; see the note in node-builder.
      */
      await ctx.onPhase?.("pre-install");
      await ctx.onPhase?.("post-install");

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
        // No trailing `-l`: it is `serve`'s listen flag and it was emitted with
        // nothing after it, so the value it took was whatever followed — which
        // was nothing at all. The port is appended by `resolveStartCmd`, which
        // is the only place that knows it.
        startCmd: `npx serve -s "${artifactDir}"`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
