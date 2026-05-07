import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const networkName = (projectSlug: string) => `runpanel-net-${projectSlug}`;

export async function ensureProjectNetwork(projectSlug: string): Promise<string> {
  const name = networkName(projectSlug);
  try {
    // Check if network exists
    await exec("docker", ["network", "inspect", name], { timeout: 10_000 });
  } catch {
    // Create it
    await exec("docker", ["network", "create", name], { timeout: 10_000 });
  }
  return name;
}

export async function connectToNetwork(containerName: string, projectSlug: string): Promise<void> {
  const name = networkName(projectSlug);
  try {
    await exec("docker", ["network", "connect", name, containerName], { timeout: 10_000 });
  } catch {
    // Already connected or network doesn't exist — ignore
  }
}

export async function removeProjectNetwork(projectSlug: string): Promise<void> {
  const name = networkName(projectSlug);
  try {
    await exec("docker", ["network", "rm", name], { timeout: 10_000 });
  } catch {
    // Network doesn't exist or has containers — ignore
  }
}

export function getNetworkName(projectSlug: string): string {
  return networkName(projectSlug);
}
