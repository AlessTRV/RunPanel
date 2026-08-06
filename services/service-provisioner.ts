import crypto from "crypto";
import { IServiceTemplate, ServiceConfig } from "./service-templates/types";
import { postgresqlTemplate } from "./service-templates/postgresql";
import { mysqlTemplate } from "./service-templates/mysql";
import { redisTemplate } from "./service-templates/redis";
import { mongodbTemplate } from "./service-templates/mongodb";
import { docker, dockerTry } from "./docker/cli";
import { labelArgs, serviceContainerName } from "./docker/labels";
import { ensureVolume, listOwnedVolumes, removeVolumes } from "./docker/volumes";

export { serviceContainerName };

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

/**
 * Build the connection URL for a service.
 *
 * `host` is the caller's decision, and it matters: an app running in a
 * container reaches the service by container name over the shared project
 * network, while a native process reaches it on localhost. There used to be two
 * separate implementations of this — one in the templates that always said
 * "localhost", and one in the deploy pipeline that was container-aware — which
 * meant the credentials shown in the UI could disagree with what was actually
 * injected into the app.
 */
export function buildConnectionString(
  type: string,
  opts: { host: string; port: number; user?: string; password?: string; database?: string }
): string {
  const { host, port, user = "", password = "", database = "" } = opts;

  switch (type) {
    case "redis":
      return `redis://${password ? `:${password}@` : ""}${host}:${port}/0`;
    case "mongodb":
      return `mongodb://${user}:${password}@${host}:${port}/${database}`;
    case "mysql":
      return `mysql://${user}:${password}@${host}:${port}/${database}`;
    default:
      return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }
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

/** Which env var name an app expects for a given service type. */
export function connectionEnvKey(type: string): string {
  if (type === "redis") return "REDIS_URL";
  if (type === "mongodb") return "MONGODB_URL";
  return "DATABASE_URL";
}

export async function provisionService(config: ServiceConfig, projectSlug?: string): Promise<string> {
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

  // Create the volumes explicitly so they carry ownership labels. Left to
  // `docker run -v`, they would be created unlabelled and become invisible to
  // the garbage collector — which is why deleted services used to leak their
  // data directory forever.
  for (const mapping of dockerConfig.volumes) {
    const volumeName = mapping.split(":")[0];
    if (volumeName && !volumeName.startsWith("/") && !volumeName.includes("\\")) {
      await ensureVolume(volumeName, ownership);
    }
  }

  const args = [
    "run", "-d",
    "--name", containerName,
    "--add-host=host.docker.internal:host-gateway",
    "-p", `${config.port}:${dockerConfig.port}`,
    "--restart", "unless-stopped",
    ...labelArgs(ownership),
  ];

  for (const [key, value] of Object.entries(dockerConfig.env)) {
    // Values go through argv, so only the key shape needs validating.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  for (const volume of dockerConfig.volumes) {
    args.push("-v", volume);
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

export async function startService(containerName: string): Promise<void> {
  await docker(["start", containerName], { timeout: 30_000 });
}

export async function stopService(containerName: string): Promise<void> {
  await docker(["stop", containerName], { timeout: 30_000 });
}

export async function restartService(containerName: string): Promise<void> {
  await docker(["restart", containerName], { timeout: 60_000 });
}

/**
 * Remove a service container, and optionally the volume holding its data.
 *
 * `removeData` defaults to false: dropping a database's storage is not
 * something to do as a side effect. Callers that mean it — deleting the service
 * from the UI — pass true after confirming.
 */
export async function removeService(
  containerName: string,
  opts: { removeData?: boolean; projectSlug?: string; serviceName?: string } = {}
): Promise<{ volumesRemoved: string[] }> {
  await dockerTry(["rm", "-f", containerName], { timeout: 30_000 });

  if (!opts.removeData) return { volumesRemoved: [] };

  const owned = await listOwnedVolumes(
    opts.projectSlug ? { project: opts.projectSlug } : {}
  );

  // Match the volumes this service created, not everything the project owns.
  const mine = owned
    .map((v) => v.name)
    .filter((name) => (opts.serviceName ? name.endsWith(`-${opts.serviceName}`) : false));

  return { volumesRemoved: await removeVolumes(mine) };
}
