import { IBuilder, BuildContext, BuildResult } from "./types";
import { docker, DockerError, lines } from "../docker/cli";
import { labelArgs } from "../docker/labels";
import { buildArgsToFlags, currentImageTag, imageTag, pullImage } from "../docker/images";
import fs from "fs";
import path from "path";

export const dockerBuilder: IBuilder = {
  name: "docker",

  async detect(projectDir: string): Promise<boolean> {
    // Compose is deliberately NOT detected here: nothing in RunPanel runs
    // `docker compose`, so claiming it would route a compose-only repo into
    // `docker build` and fail with a confusing "Dockerfile not found".
    return fs.existsSync(path.join(projectDir, "Dockerfile"));
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, onLog } = ctx;
    const slug = ctx.slug ?? path.basename(projectDir);
    const deploymentId = ctx.deploymentId ?? "manual";

    // Template mode: a prebuilt image, nothing to build.
    if (ctx.dockerImage) {
      try {
        await pullImage(ctx.dockerImage, onLog);
        onLog(`Image pulled: ${ctx.dockerImage}`);
        return { success: true, artifactDir: projectDir, startCmd: `docker:${ctx.dockerImage}` };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Docker pull failed";
        onLog(`ERROR: ${message}`);
        return { success: false, artifactDir: projectDir, startCmd: "", error: message };
      }
    }

    const versioned = imageTag(slug, deploymentId);
    const current = currentImageTag(slug);
    const buildArgs = ctx.buildArgs ?? {};

    // Two tags on one build: an immutable one per deployment so an older image
    // is still addressable, and a moving alias the runtime starts from. The
    // previous builder reused a single tag, which orphaned the prior image as a
    // dangling layer set on every redeploy.
    const args = [
      "build",
      "-t", versioned,
      "-t", current,
      ...labelArgs({ project: slug, kind: "app", deployment: deploymentId }),
      ...buildArgsToFlags(buildArgs),
    ];

    if (ctx.dockerfile) args.push("-f", ctx.dockerfile);
    if (ctx.target) args.push("--target", ctx.target);
    args.push(ctx.buildContext ?? ".");

    const argNames = Object.keys(buildArgs);
    if (argNames.length > 0) {
      // Names only — a build arg is frequently a secret.
      onLog(`Build args: ${argNames.join(", ")}`);
    }
    onLog(`> docker build -t ${versioned} -t ${current} ${ctx.buildContext ?? "."}`);

    try {
      const result = await docker(args, { cwd: projectDir, timeout: ctx.buildTimeout ?? 900_000 });
      for (const line of lines(result.stderr)) onLog(line);
      onLog(`Docker image built: ${versioned}`);

      return { success: true, artifactDir: projectDir, startCmd: `docker:${current}` };
    } catch (err: unknown) {
      const message =
        err instanceof DockerError
          ? err.stderr || err.message
          : err instanceof Error
            ? err.message
            : "Docker build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
