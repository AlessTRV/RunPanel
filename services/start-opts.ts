import type { DeployContract } from "@/lib/deploy-contract";
import type { ProjectsTable } from "@/lib/db/schema";
import type { StartOpts } from "./process-drivers/types";
import { writeEnvFile } from "./env-file";
import { mountStringSchema } from "@/lib/validation";

/**
 * The arguments a project's process is started with, in one place.
 *
 * There were two: the deploy pipeline built them, and `project-restart.ts` built
 * them again for a restart that skips the build. Its own header says why it
 * exists — the restart before it replayed only the command, the directory, the
 * environment and the port, and silently dropped the mounts, the network, the
 * added capabilities and the restart policy. It fixed that by copying the list,
 * which fixed it once and left the two free to drift again.
 *
 * They had already drifted. A Docker project with `envFile.enabled` gets its
 * `.env` as a read-only bind, appended to `contract.docker.mounts` **in memory**
 * at deploy time and never written back to the row. The restart re-read the
 * stored contract, which does not have it, so every manual restart and every
 * boot brought the app back without the file it was told to read — and the
 * mount list was invisible in the panel, so nobody could see it go.
 *
 * One function, and the appended mount is part of what it returns rather than
 * something a caller has to remember.
 */
export function buildStartOpts(ctx: {
  project: Pick<ProjectsTable, "slug" | "runtime_type">;
  contract: DeployContract;
  envVars: Record<string, string>;
  cwd: string;
  port: number;
  loopbackPort?: number;
  deploymentId?: string;
  onLog?: (line: string) => void;
}): StartOpts {
  const { project, contract, envVars } = ctx;

  /*
    PORT and NODE_ENV belong to every start, not only to a deploy.

    They used to be set on the in-memory map inside the deploy pipeline and
    were never persisted, so a restart — which rebuilds the environment from
    the `env_vars` rows — brought a container back with no PORT at all, and
    left `${PORT}` resolving to nothing in a compose file's interpolation. The
    pm2 driver sets both itself, which is why only the container runtimes ever
    showed it. Here they are set once, on the path both callers share.

    A copy rather than a mutation: the caller's map is the same object the
    release command and the one-time commands are handed, and editing it from
    in here would be a side effect nobody reading those call sites can see.
  */
  const env = { ...envVars };
  if (ctx.port > 0) env.PORT = String(ctx.port);
  if (!env.NODE_ENV) env.NODE_ENV = "production";

  /*
    Re-checked here, where the strings become `docker run -v` arguments.

    `mountStringSchema` was written for exactly this and then never wired to
    anything — its own comment claimed it ran at the route, and no route imported
    it. The mount editor validates the row form it saves, but a contract can also
    arrive from a restored backup or from a hand-edited column, and those never
    passed any check at all. A mapping that fails is dropped and named rather
    than handed to the daemon.
  */
  const mounts: string[] = [];
  for (const mount of contract.docker.mounts) {
    if (mountStringSchema.safeParse(mount).success) {
      mounts.push(mount);
      continue;
    }
    ctx.onLog?.(`Mount ignorato, non è una mappatura valida: ${mount}`);
  }

  // Only the container runtime gets the file as a mount. A native process reads
  // one written into its own directory at deploy time, which is still there.
  if (contract.envFile.enabled && project.runtime_type === "docker") {
    const hostPath = writeEnvFile(project.slug, env);
    mounts.push(`${hostPath}:${contract.envFile.path}:ro`);
    ctx.onLog?.(`Wrote env file for mounting at ${contract.envFile.path}`);
  }

  return {
    cwd: ctx.cwd,
    env,
    port: ctx.port,
    loopbackPort: ctx.loopbackPort,
    deploymentId: ctx.deploymentId,
    onLog: ctx.onLog,
    restartPolicy: contract.runtime.restartPolicy,
    network: contract.docker.network,
    hostname: contract.docker.hostname,
    capAdd: contract.docker.capAdd,
    extraHosts: contract.docker.extraHosts,
    mounts,
    memory: contract.runtime.memory,
    cpus: contract.runtime.cpus,
    shmSize: contract.runtime.shmSize,
  };
}
