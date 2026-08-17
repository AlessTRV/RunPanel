import type { DeployContract } from "@/lib/deploy-contract";
import type { ProjectsTable } from "@/lib/db/schema";
import type { StartOpts } from "./process-drivers/types";
import { writeEnvFile } from "./env-file";

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

  const mounts = [...contract.docker.mounts];

  // Only the container runtime gets the file as a mount. A native process reads
  // one written into its own directory at deploy time, which is still there.
  if (contract.envFile.enabled && project.runtime_type === "docker") {
    const hostPath = writeEnvFile(project.slug, envVars);
    mounts.push(`${hostPath}:${contract.envFile.path}:ro`);
    ctx.onLog?.(`Wrote env file for mounting at ${contract.envFile.path}`);
  }

  return {
    cwd: ctx.cwd,
    env: envVars,
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
