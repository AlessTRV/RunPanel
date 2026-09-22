import fs from "fs";
import path from "path";
import { docker, dockerTry, dockerStream, lines } from "./cli";
import { config } from "@/lib/config";
import type { ResolvedComposeConfig } from "@/lib/compose-network";

/**
 * Docker Compose support.
 *
 * Previously the Docker builder claimed to detect `docker-compose.yml` and then
 * routed the project into `docker build`, which failed with a confusing
 * "Dockerfile not found". Nothing ever ran compose. This is the missing half.
 *
 * Ownership works differently here: compose stamps its own
 * `com.docker.compose.project` label on everything it creates and refuses
 * `--label` on `up`, so the project NAME is the ownership handle. Deriving it
 * from the slug keeps it predictable and scoped.
 */

const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export function composeProjectName(slug: string): string {
  // Compose only accepts lowercase alphanumerics, dashes and underscores.
  return `runpanel-${slug}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/** The compose file in a checkout, if there is one. */
export function findComposeFile(projectDir: string): string | null {
  for (const name of COMPOSE_FILES) {
    const full = path.join(projectDir, name);
    if (fs.existsSync(full)) return name;
  }
  return null;
}

export function hasCompose(projectDir: string): boolean {
  return findComposeFile(projectDir) !== null;
}

function baseArgs(ctx: ComposeContext): string[] {
  const args = ["compose", "--project-directory", ctx.projectDir, "-f", path.join(ctx.projectDir, ctx.file)];
  // The panel's override goes after the user's file, so what it adds merges
  // on top of what they wrote — an extra network on every service, nothing
  // else. Every verb sees it: an `up` from a restart that forgot it would
  // recreate the stack off the project network.
  if (ctx.overrideFile) args.push("-f", ctx.overrideFile);
  args.push("-p", composeProjectName(ctx.slug));
  return args;
}

export interface ComposeContext {
  slug: string;
  projectDir: string;
  file: string;
  /**
   * The override the deploy generated to attach the stack to the project
   * network, when there is one on disk. Absolute, and outside the checkout.
   */
  overrideFile: string | null;
}

/**
 * Where a project's override is kept. Resolved here rather than imported from
 * `compose-network.ts`, which imports this module — and keyed by slug so a
 * driver asked to restart a stack finds the file without being told about it.
 */
export function composeOverridePath(slug: string): string {
  return path.join(config.dataDir, "compose", `${slug}.override.yml`);
}

export function composeContext(slug: string, projectDir: string): ComposeContext | null {
  const file = findComposeFile(projectDir);
  if (!file) return null;

  const override = composeOverridePath(slug);
  return { slug, projectDir, file, overrideFile: fs.existsSync(override) ? override : null };
}

/**
 * The stack as compose sees it, resolved from the user's file alone.
 *
 * `--format json` is what the network override is generated from: it names
 * every service, says which are on `network_mode` and cannot take a network,
 * and shows `default` explicitly on the ones that have no `networks` of their
 * own. The override is deliberately not included — resolved with it, every
 * service would already appear attached.
 */
export async function composeConfigJson(
  ctx: ComposeContext,
  env: Record<string, string>
): Promise<ResolvedComposeConfig> {
  const result = await docker(
    [...baseArgs({ ...ctx, overrideFile: null }), "config", "--format", "json"],
    { cwd: ctx.projectDir, timeout: 60_000, env }
  );
  return JSON.parse(result.stdout) as ResolvedComposeConfig;
}

/**
 * Validate the file before doing anything with it. `config` resolves variable
 * interpolation and reports a broken file with a usable message, which is much
 * better than a failure halfway through `up`.
 */
export async function composeValidate(ctx: ComposeContext, env: Record<string, string>): Promise<void> {
  await docker([...baseArgs(ctx), "config", "--quiet"], {
    cwd: ctx.projectDir,
    timeout: 60_000,
    env,
  });
}

export async function composeBuild(
  ctx: ComposeContext,
  opts: { buildArgs?: Record<string, string>; env: Record<string, string>; timeout?: number; onLog: (line: string) => void }
): Promise<void> {
  const args = [...baseArgs(ctx), "build"];

  // Compose accepts --build-arg only per service, but honours the ambient
  // environment for `args:` entries declared without a value — which is the
  // idiomatic way to thread NEXT_PUBLIC_* style values through.
  for (const key of Object.keys(opts.buildArgs ?? {})) {
    opts.onLog(`Build arg available to compose: ${key}`);
  }

  opts.onLog(`> docker compose -f ${ctx.file} build`);
  const result = await docker(args, {
    cwd: ctx.projectDir,
    timeout: opts.timeout ?? 900_000,
    env: { ...opts.env, ...(opts.buildArgs ?? {}) },
  });

  for (const line of lines(result.stderr)) opts.onLog(line);
}

export async function composeUp(
  ctx: ComposeContext,
  opts: { env: Record<string, string>; onLog?: (line: string) => void }
): Promise<void> {
  // `--remove-orphans` so a service deleted from the compose file does not keep
  // running forever; `--wait` so a failed container surfaces here rather than
  // as a mysterious health check timeout later.
  const result = await docker(
    [...baseArgs(ctx), "up", "-d", "--remove-orphans", "--wait"],
    { cwd: ctx.projectDir, timeout: 600_000, env: opts.env }
  );
  for (const line of lines(result.stderr)) opts.onLog?.(line);
}

export async function composeStop(ctx: ComposeContext): Promise<void> {
  await dockerTry([...baseArgs(ctx), "stop"], {
    cwd: ctx.projectDir,
    timeout: 120_000,
  });
}

export async function composeStart(ctx: ComposeContext): Promise<void> {
  await docker([...baseArgs(ctx), "start"], {
    cwd: ctx.projectDir,
    timeout: 120_000,
  });
}

export async function composeRestart(ctx: ComposeContext): Promise<void> {
  await docker([...baseArgs(ctx), "restart"], {
    cwd: ctx.projectDir,
    timeout: 180_000,
  });
}

/**
 * Tear the stack down. Volumes are kept unless explicitly asked for — they hold
 * the data, and losing them must be a decision rather than a side effect.
 */
export async function composeDown(ctx: ComposeContext, opts: { removeVolumes?: boolean } = {}): Promise<void> {
  const args = [...baseArgs(ctx), "down", "--remove-orphans"];
  if (opts.removeVolumes) args.push("--volumes");
  await dockerTry(args, { cwd: ctx.projectDir, timeout: 180_000 });
}

export interface ComposeService {
  name: string;
  state: string;
  health: string | null;
}

export async function composePs(ctx: ComposeContext): Promise<ComposeService[]> {
  const result = await dockerTry(
    [...baseArgs(ctx), "ps", "--format", "json", "-a"],
    { cwd: ctx.projectDir, timeout: 30_000 }
  );
  if (!result) return [];

  // Compose emits one JSON object per line, not a JSON array.
  const services: ComposeService[] = [];
  for (const line of lines(result.stdout)) {
    try {
      const parsed = JSON.parse(line) as { Service?: string; Name?: string; State?: string; Health?: string };
      services.push({
        name: parsed.Service ?? parsed.Name ?? "unknown",
        state: parsed.State ?? "unknown",
        health: parsed.Health || null,
      });
    } catch {
      /* a stray non-JSON line is not worth failing over */
    }
  }
  return services;
}

export async function composeLogs(
  ctx: ComposeContext,
  tail: number,
  /** `--since <stamp>`, so the caller can scope the output to the current run. */
  extraArgs: string[] = []
): Promise<string[]> {
  const result = await dockerTry(
    [...baseArgs(ctx), "logs", "--tail", String(tail), "--no-color", ...extraArgs],
    { cwd: ctx.projectDir, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );
  return result ? lines(`${result.stdout}\n${result.stderr}`) : [];
}

export function composeFollow(ctx: ComposeContext, onLine: (line: string) => void): () => void {
  return dockerStream(
    [...baseArgs(ctx), "logs", "-f", "--tail", "0", "--no-color"],
    onLine
  );
}

