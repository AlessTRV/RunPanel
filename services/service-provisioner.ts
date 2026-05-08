import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import { IServiceTemplate, ServiceConfig } from "./service-templates/types";
import { postgresqlTemplate } from "./service-templates/postgresql";
import { mysqlTemplate } from "./service-templates/mysql";
import { redisTemplate } from "./service-templates/redis";
import { mongodbTemplate } from "./service-templates/mongodb";

const exec = promisify(execFile);

const templates: Record<string, IServiceTemplate> = {
  postgresql: postgresqlTemplate,
  mysql: mysqlTemplate,
  redis: redisTemplate,
  mongodb: mongodbTemplate,
};

export function getTemplate(type: string): IServiceTemplate | null {
  return templates[type] || null;
}

export function generateCredentials(type: string): { user: string; password: string; database: string } {
  const password = crypto.randomBytes(16).toString("hex");
  if (type === "redis") {
    return { user: "", password, database: "0" };
  }
  return { user: "runpanel", password, database: "runpanel_db" };
}

export async function provisionService(config: ServiceConfig, projectSlug?: string): Promise<string> {
  const template = getTemplate(config.type);
  if (!template) throw new Error(`Unknown service type: ${config.type}`);

  const dockerConfig = template.getDockerConfig(config);
  const containerName = `runpanel-svc-${config.name}`;

  // Ensure project network exists if project is linked
  if (projectSlug) {
    const { ensureProjectNetwork } = await import("./docker-network");
    await ensureProjectNetwork(projectSlug);
  }

  // Remove existing container if any
  try {
    await exec("docker", ["rm", "-f", containerName], { timeout: 15_000 });
  } catch { /* ignore */ }

  // Build docker run args — use default bridge network for internet access
  const args: string[] = [
    "run", "-d",
    "--name", containerName,
    "--add-host=host.docker.internal:host-gateway",
    "-p", `${config.port}:${dockerConfig.port}`,
    "--restart", "unless-stopped",
  ];

  // Add environment vars — values passed as separate args to execFile (no shell injection risk)
  for (const [key, value] of Object.entries(dockerConfig.env)) {
    // Validate key is alphanumeric, value is passed safely via execFile array
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Add volumes
  for (const vol of dockerConfig.volumes) {
    args.push("-v", vol);
  }

  args.push(dockerConfig.image);

  // Redis with password requires special command
  if (config.type === "redis" && config.credentials.password) {
    args.push("redis-server", "--requirepass", config.credentials.password);
  }

  const { stdout } = await exec("docker", args, { timeout: 120_000 });

  // Connect to project network after run (keeps default bridge for internet + host access)
  if (projectSlug) {
    try {
      const { connectToNetwork } = await import("./docker-network");
      await connectToNetwork(containerName, projectSlug);
    } catch { /* ignore */ }
  }

  return stdout.trim().slice(0, 12); // container ID
}

export async function startService(containerName: string): Promise<void> {
  await exec("docker", ["start", `runpanel-svc-${containerName}`], { timeout: 15_000 });
}

export async function stopService(containerName: string): Promise<void> {
  await exec("docker", ["stop", `runpanel-svc-${containerName}`], { timeout: 15_000 });
}

export async function restartService(containerName: string): Promise<void> {
  await exec("docker", ["restart", `runpanel-svc-${containerName}`], { timeout: 15_000 });
}

export async function removeService(containerName: string): Promise<void> {
  try {
    await exec("docker", ["rm", "-f", `runpanel-svc-${containerName}`], { timeout: 15_000 });
  } catch { /* ignore */ }
}

export function getConnectionString(config: ServiceConfig): string {
  const template = getTemplate(config.type);
  if (!template) return "";
  return template.getConnectionString(config);
}
