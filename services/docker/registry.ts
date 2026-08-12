import fs from "fs";
import path from "path";
import { z } from "zod";
import { config } from "@/lib/config";
import { decrypt, encrypt } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Credentials for private image registries.
 *
 * Rather than running `docker login`, which writes into the host user's
 * `~/.docker/config.json` and would silently affect anything else that user
 * runs, RunPanel keeps its own Docker config directory and points `DOCKER_CONFIG`
 * at it. The panel's credentials stay the panel's.
 *
 * Passwords are encrypted at rest with the same key as every other secret and
 * are only ever written out to a 0600 file.
 */

const REGISTRY_SETTING_KEY = "docker_registries";

export const registrySchema = z.object({
  /** Registry host. Docker Hub is the empty-ish default below. */
  registry: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(4096),
});

export type RegistryCredential = z.infer<typeof registrySchema>;

/** What the UI is allowed to see: never the password. */
export interface RegistrySummary {
  registry: string;
  username: string;
}

export const DOCKER_HUB = "https://index.docker.io/v1/";

export function dockerConfigDir(): string {
  return path.join(config.dataDir, "docker-config");
}

/**
 * `DOCKER_CONFIG` for docker invocations. Returns null when no registry has
 * been configured, so the default behaviour — inheriting whatever the host user
 * has — is unchanged for anyone who does not need this.
 */
export function dockerConfigEnv(): Record<string, string> | null {
  const dir = dockerConfigDir();
  return fs.existsSync(path.join(dir, "config.json")) ? { DOCKER_CONFIG: dir } : null;
}

async function readCredentials(): Promise<RegistryCredential[]> {
  const stored = await getSetting(REGISTRY_SETTING_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(decrypt(stored)) as unknown;
    const result = z.array(registrySchema).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/** Registries the panel knows about, without their passwords. */
export async function listRegistries(): Promise<RegistrySummary[]> {
  return (await readCredentials()).map(({ registry, username }) => ({ registry, username }));
}

/**
 * Write the auth file Docker reads.
 *
 * The `auths` entry is base64 of `user:password` — that is Docker's own format,
 * not encryption, which is exactly why the file is 0600 and lives under the
 * data directory rather than anywhere shared.
 */
function materialize(credentials: RegistryCredential[]): void {
  const dir = dockerConfigDir();
  const file = path.join(dir, "config.json");

  if (credentials.length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const auths: Record<string, { auth: string }> = {};
  for (const cred of credentials) {
    auths[cred.registry] = {
      auth: Buffer.from(`${cred.username}:${cred.password}`).toString("base64"),
    };
  }

  fs.writeFileSync(file, JSON.stringify({ auths }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* chmod is a no-op on some Windows filesystems */
  }
}

async function persist(credentials: RegistryCredential[]): Promise<void> {
  await setSetting(REGISTRY_SETTING_KEY, encrypt(JSON.stringify(credentials)));
  materialize(credentials);
}

/** Add or replace the credentials for one registry. */
export async function saveRegistry(credential: RegistryCredential): Promise<void> {
  const existing = await readCredentials();
  const others = existing.filter((c) => c.registry !== credential.registry);
  await persist([...others, credential]);
}

export async function removeRegistry(registry: string): Promise<void> {
  const existing = await readCredentials();
  await persist(existing.filter((c) => c.registry !== registry));
}

/**
 * Rebuild the auth file from the store.
 *
 * Called at boot: the data directory can outlive a container rebuild, or the
 * file can simply be missing, and a silently unauthenticated pull is a confusing
 * way to discover that.
 */
export async function syncRegistryConfig(): Promise<number> {
  const credentials = await readCredentials();
  materialize(credentials);
  return credentials.length;
}
