import crypto from "crypto";
import { decrypt } from "@/lib/crypto";
import type { ServicesTable } from "@/lib/db/schema";
import { buildConnectionString } from "@/lib/service-env";
import { IServiceTemplate, ServiceConfig } from "./service-templates/types";
import { postgresqlTemplate } from "./service-templates/postgresql";
import { mysqlTemplate } from "./service-templates/mysql";
import { redisTemplate } from "./service-templates/redis";
import { mongodbTemplate } from "./service-templates/mongodb";
import { docker, dockerTry } from "./docker/cli";
import { labelArgs, serviceContainerName } from "./docker/labels";
import {
  ensureVolume,
  isHostPath,
  listOwnedVolumes,
  mountSource,
  removeVolumes,
} from "./docker/volumes";
import { AccessRow, publishArg } from "./access";

export { serviceContainerName };

/** What a service with no access columns yet gets: published as it always was. */
const OPEN_ACCESS: AccessRow = { access_mode: "open", access_allow: null, access_port: null };

const templates: Record<string, IServiceTemplate> = {
  postgresql: postgresqlTemplate,
  mysql: mysqlTemplate,
  redis: redisTemplate,
  mongodb: mongodbTemplate,
};

export function getTemplate(type: string): IServiceTemplate | null {
  return templates[type] ?? null;
}

export function generateCredentials(type: string): { user: string; password: string; database: string } {
  const password = crypto.randomBytes(16).toString("hex");
  if (type === "redis") {
    return { user: "", password, database: "0" };
  }
  return { user: "runpanel", password, database: "runpanel_db" };
}

export function getConnectionString(config: ServiceConfig, host = "localhost"): string {
  return buildConnectionString(config.type, {
    host,
    port: config.port,
    user: config.credentials.user,
    password: config.credentials.password,
    database: config.credentials.database,
  });
}

/**
 * The port the service listens on INSIDE its container.
 *
 * Not the same number as the one stored on the service, which is where it is
 * published on the host. A container on the project network talks to the
 * service by container name, and the published mapping plays no part there — so
 * a Postgres published on 5433 because 5432 was taken is still reached on 5432.
 *
 * Read from the template rather than restated, so it cannot disagree with the
 * port the container actually exposes.
 */
export function internalPort(type: string, fallback: number): number {
  const template = getTemplate(type);
  if (!template) return fallback;

  return template.getDockerConfig({
    name: "probe",
    type: type as ServiceConfig["type"],
    version: template.defaultVersion,
    port: fallback,
    credentials: { user: "", password: "", database: "" },
  }).port;
}

/**
 * Create and start the container for a service.
 *
 * `access` decides where the port is published. Open — the default, and what
 * every service did before the column existed — publishes on every interface.
 * Restricted publishes on loopback only, on the moved port, and the caller
 * opens the panel's gate in front of it afterwards. The publish spec is fixed
 * at `run`, which is why changing the restriction has to come back through
 * here rather than through `docker start`.
 */
export async function provisionService(
  config: ServiceConfig,
  projectSlug?: string,
  access?: AccessRow
): Promise<string> {
  const template = getTemplate(config.type);
  if (!template) throw new Error(`Unknown service type: ${config.type}`);

  const dockerConfig = template.getDockerConfig(config);
  const containerName = serviceContainerName(config.name, projectSlug);
  const ownership = { project: projectSlug, kind: "service" as const, service: config.name };

  if (projectSlug) {
    const { ensureProjectNetwork } = await import("./docker-network");
    await ensureProjectNetwork(projectSlug);
  }

  await dockerTry(["rm", "-f", containerName], { timeout: 15_000 });

  const mounts = resolveMounts(dockerConfig.volumes, config.dataPath);

  // Create the volumes explicitly so they carry ownership labels. Left to
  // `docker run -v`, they would be created unlabelled and become invisible to
  // the garbage collector — which is why deleted services used to leak their
  // data directory forever.
  for (const mount of mounts) {
    // A host directory is the operator's, not the panel's: Docker binds it as
    // it finds it, and creating a "volume" of that name would be creating
    // something else entirely.
    if (mount.source && !isHostPath(mount.source)) {
      await ensureVolume(mount.source, ownership);
    }
  }

  const args = [
    "run", "-d",
    "--name", containerName,
    "--add-host=host.docker.internal:host-gateway",
    "-p", publishArg(access ?? OPEN_ACCESS, config.port, dockerConfig.port),
    "--restart", "unless-stopped",
    ...labelArgs(ownership),
  ];

  for (const [key, value] of Object.entries(dockerConfig.env)) {
    // Values go through argv, so only the key shape needs validating.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  for (const mount of mounts) {
    args.push("-v", `${mount.source}:${mount.target}`);
  }

  args.push(dockerConfig.image);

  if (config.type === "redis" && config.credentials.password) {
    args.push("redis-server", "--requirepass", config.credentials.password);
  }

  const { stdout } = await docker(args, { timeout: 180_000 });

  if (projectSlug) {
    try {
      const { connectToNetwork } = await import("./docker-network");
      await connectToNetwork(containerName, projectSlug);
    } catch {
      /* the container still works on the default bridge */
    }
  }

  return stdout.trim().slice(0, 12);
}

export interface VolumeMount {
  source: string;
  target: string;
}

/**
 * The mappings a container is actually created with.
 *
 * The templates always declare the named volume they would create — that is the
 * question `serviceVolumeNames` asks them, and the answer has to stay the same
 * wherever the data has since been moved. So the substitution happens exactly
 * here, once, on the first mapping: the data directory is the first volume in
 * every template and none of them declares a second.
 */
export function resolveMounts(volumes: string[], dataPath?: string | null): VolumeMount[] {
  return volumes.map((mapping, index) => {
    const source = mountSource(mapping);
    const target = mapping.slice(source.length + 1);
    return index === 0 && dataPath ? { source: dataPath, target } : { source, target };
  });
}

/** Where this service's data goes, as a structured pair. */
export function dataMountFor(config: ServiceConfig): VolumeMount {
  const template = getTemplate(config.type);
  const volumes = template?.getDockerConfig(config).volumes ?? [];
  return resolveMounts(volumes, config.dataPath)[0] ?? { source: "", target: "" };
}

/**
 * A service row as the arguments it runs with.
 *
 * One function, because the mapping is easy to get *almost* right by hand and
 * the omission is invisible: the access PATCH used to rebuild this inline, and
 * the day a service could name its own data directory that rebuild would have
 * silently remounted it on the default volume. On PostgreSQL 18 that is the
 * trap `postgresVolumePath` documents — it initialises elsewhere, works
 * perfectly, and comes back empty.
 */
export function serviceRunConfig(
  service: ServicesTable,
  projectSlug?: string,
  overrides: { dataPath?: string | null } = {}
): ServiceConfig {
  let credentials = { user: "", password: "", database: "" };
  try {
    if (service.credentials) {
      credentials = { ...credentials, ...JSON.parse(decrypt(service.credentials)) };
    }
  } catch {
    /* an unreadable credential yields a container that fails loudly */
  }

  return {
    name: service.name,
    type: service.type,
    version: service.version,
    port: service.port,
    credentials,
    projectSlug,
    dataPath: "dataPath" in overrides ? overrides.dataPath : service.data_path,
  };
}

/**
 * Put the container back with a different publish spec or a different data
 * directory.
 *
 * Recreated rather than restarted: `-p` and `-v` are both fixed at
 * `docker run`, and `docker start` replays whatever the container was created
 * with. A service that was not running goes back to not running — it does start
 * for a moment on the way, which is also the only way to find out that the new
 * binding is one the host will accept.
 */
export async function recreateService(
  service: ServicesTable,
  projectSlug: string | undefined,
  access: AccessRow,
  overrides: { dataPath?: string | null } = {}
): Promise<{ containerId: string; status: ServicesTable["status"] }> {
  const config = serviceRunConfig(service, projectSlug, overrides);
  const containerId = await provisionService(config, projectSlug, access);

  if (service.status === "running") return { containerId, status: "running" };

  await stopService(service.container_name).catch(() => {
    /* it is recreated either way; the status returned is what the panel reports */
  });
  return { containerId, status: "stopped" };
}

export async function startService(containerName: string): Promise<void> {
  await docker(["start", containerName], { timeout: 30_000 });
}

export async function stopService(containerName: string): Promise<void> {
  await docker(["stop", containerName], { timeout: 30_000 });
}

export async function restartService(containerName: string): Promise<void> {
  await docker(["restart", containerName], { timeout: 60_000 });
}

/** Enough of a service to name its container and its volumes. */
export interface ServiceIdentity {
  type: string;
  name: string;
  projectSlug?: string | null;
}

/**
 * The volumes belonging to one service, named by the same code that created
 * them so the two cannot drift.
 *
 * The previous answer to this question was `name.endsWith("-" + serviceName)`
 * over every volume RunPanel owns on the host. For a service scoped to a
 * project that was merely sloppy — it also matched a sibling service called
 * `main-db`. For a service with no project it listed the whole host unscoped,
 * so deleting a service called `db` would have taken `runpanel-pg-anyproject-db`
 * with it: every project's database, gone, from one confirmation dialog.
 */
export function serviceVolumeNames(service: ServiceIdentity): string[] {
  const template = getTemplate(service.type);
  if (!template) return [];

  const dockerConfig = template.getDockerConfig({
    name: service.name,
    type: service.type as ServiceConfig["type"],
    version: template.defaultVersion,
    port: 0,
    credentials: { user: "", password: "", database: "" },
    projectSlug: service.projectSlug ?? undefined,
  });

  return dockerConfig.volumes
    .map(mountSource)
    .filter((name) => Boolean(name) && !isHostPath(name));
}

/**
 * Remove a service container, and optionally the volume holding its data.
 *
 * `removeData` defaults to false: dropping a database's storage is not
 * something to do as a side effect. Callers that mean it — deleting the service
 * from the UI — pass true after confirming.
 *
 * Without `service` there is no way to know which volumes are this one's, so
 * nothing is removed. Guessing is what the old implementation did.
 */
export async function removeService(
  containerName: string,
  opts: { removeData?: boolean; service?: ServiceIdentity } = {}
): Promise<{ volumesRemoved: string[] }> {
  await dockerTry(["rm", "-f", containerName], { timeout: 30_000 });

  if (!opts.removeData || !opts.service) return { volumesRemoved: [] };

  // Intersected with what RunPanel actually owns: the names above are derived
  // from a user-supplied service name, and `docker volume rm` on a name this
  // panel never created is not ours to run.
  const owned = new Set((await listOwnedVolumes()).map((v) => v.name));
  const mine = serviceVolumeNames(opts.service).filter((name) => owned.has(name));

  return { volumesRemoved: await removeVolumes(mine) };
}
