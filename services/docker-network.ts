import { docker, dockerTry } from "./docker/cli";
import { labelArgs, networkName } from "./docker/labels";

export { networkName as getNetworkName };

export async function ensureProjectNetwork(projectSlug: string): Promise<string> {
  const name = networkName(projectSlug);

  const existing = await dockerTry(["network", "inspect", name], { timeout: 10_000 });
  if (!existing) {
    // Labelled like everything else, so the garbage collector can recognise a
    // network left behind by a deleted project.
    await docker(["network", "create", ...labelArgs({ project: projectSlug, kind: "network" }), name], {
      timeout: 15_000,
    });
  }

  return name;
}

export async function connectToNetwork(containerName: string, projectSlug: string): Promise<void> {
  // Already-connected is a normal outcome, not an error worth surfacing.
  await dockerTry(["network", "connect", networkName(projectSlug), containerName], {
    timeout: 10_000,
  });
}

export async function removeProjectNetwork(projectSlug: string): Promise<void> {
  await dockerTry(["network", "rm", networkName(projectSlug)], { timeout: 15_000 });
}
