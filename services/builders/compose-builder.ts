import { IBuilder, BuildContext, BuildResult } from "./types";
import { DockerError } from "../docker/cli";
import { composeBuild, composeContext, composeValidate, hasCompose } from "../docker/compose";

/**
 * Builds a project that ships a compose file.
 *
 * The stack itself is started by the compose driver — this only produces the
 * images, so a build failure is reported before anything is torn down and
 * replaced.
 */
export const composeBuilder: IBuilder = {
  name: "compose",

  async detect(projectDir: string): Promise<boolean> {
    return hasCompose(projectDir);
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const { projectDir, onLog } = ctx;
    const slug = ctx.slug ?? "project";
    const compose = composeContext(slug, projectDir);

    if (!compose) {
      return { success: false, artifactDir: projectDir, startCmd: "", error: "No compose file found" };
    }

    const env = { ...ctx.envVars, ...(ctx.buildArgs ?? {}) };

    try {
      // Resolve the file first: a broken compose file or an unset required
      // variable produces a clear message here instead of failing mid-build.
      onLog(`> docker compose -f ${compose.file} config`);
      await composeValidate(compose, env);

      await composeBuild(compose, {
        buildArgs: ctx.buildArgs,
        env,
        timeout: ctx.buildTimeout,
        onLog,
      });

      onLog(`Compose stack built from ${compose.file}`);
      return { success: true, artifactDir: projectDir, startCmd: `compose:${compose.file}` };
    } catch (err: unknown) {
      const message =
        err instanceof DockerError
          ? err.stderr || err.message
          : err instanceof Error
            ? err.message
            : "Compose build failed";
      onLog(`ERROR: ${message}`);
      return { success: false, artifactDir: projectDir, startCmd: "", error: message };
    }
  },
};
