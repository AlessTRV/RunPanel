import { IBuilder, BuildContext, BuildResult } from "./types";
import { runCommand } from "./run-command";
import fs from "fs";
import path from "path";

export const dockerBuilder: IBuilder = {
  name: "docker",

  async detect(projectDir: string): Promise<boolean> {
    return (
      fs.existsSync(path.join(projectDir, "Dockerfile")) ||
      fs.existsSync(path.join(projectDir, "docker-compose.yml")) ||
      fs.existsSync(path.join(projectDir, "docker-compose.yaml"))
    );
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, onLog } = ctx;

    // Check if using a Docker template (pre-built image, no Dockerfile needed)
    const dockerImage = ctx.dockerImage || null;

    if (dockerImage) {
      // Template mode: pull the image directly
      try {
        onLog(`> docker pull ${dockerImage}`);
        await runCommand(`docker pull ${dockerImage}`, {
          cwd: projectDir,
          timeout: 300_000,
          onLog,
        });
        onLog(`Image pulled: ${dockerImage}`);

        return {
          success: true,
          artifactDir: projectDir,
          startCmd: `docker:${dockerImage}`,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Docker pull failed";
        onLog(`ERROR: ${message}`);
        return { success: false, artifactDir: projectDir, startCmd: "", error: message };
      }
    }

    // Custom Dockerfile mode: build from source
    const imageName = `runpanel-${path.basename(projectDir)}`;

    try {
      onLog(`> docker build -t ${imageName} .`);
      await runCommand(`docker build -t ${imageName} .`, {
        cwd: projectDir,
        timeout: 600_000,
        onLog,
      });
      onLog(`Docker image built: ${imageName}`);

      return {
        success: true,
        artifactDir: projectDir,
        startCmd: `docker:${imageName}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Docker build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
