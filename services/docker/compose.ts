import fs from "fs";
import path from "path";
import { docker, dockerTry, dockerStream, lines } from "./cli";

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

function baseArgs(slug: string, projectDir: string, file: string): string[] {
  return ["compose", "--project-directory", projectDir, "-f", path.join(projectDir, file), "-p", composeProjectName(slug)];
}

export interface ComposeContext {
  slug: string;
  projectDir: string;
  file: string;
}

export function composeContext(slug: string, projectDir: string): ComposeContext | null {
  const file = findComposeFile(projectDir);
  return file ? { slug, projectDir, file } : null;
}

/**
 * Validate the file before doing anything with it. `config` resolves variable
 * interpolation and reports a broken file with a usable message, which is much
 * better than a failure halfway through `up`.
 */
export async function composeValidate(ctx: ComposeContext, env: Record<string, string>): Promise<void> {
  await docker([...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "config", "--quiet"], {
    cwd: ctx.projectDir,
    timeout: 60_000,
    env,
  });
}

export async function composeBuild(
  ctx: ComposeContext,
  opts: { buildArgs?: Record<string, string>; env: Record<string, string>; timeout?: number; onLog: (line: string) => void }
): Promise<void> {
  const args = [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "build"];

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
    [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "up", "-d", "--remove-orphans", "--wait"],
    { cwd: ctx.projectDir, timeout: 600_000, env: opts.env }
  );
  for (const line of lines(result.stderr)) opts.onLog?.(line);
}

export async function composeStop(ctx: ComposeContext): Promise<void> {
  await dockerTry([...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "stop"], {
    cwd: ctx.projectDir,
    timeout: 120_000,
  });
}

export async function composeStart(ctx: ComposeContext): Promise<void> {
  await docker([...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "start"], {
    cwd: ctx.projectDir,
    timeout: 120_000,
  });
}

export async function composeRestart(ctx: ComposeContext): Promise<void> {
  await docker([...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "restart"], {
    cwd: ctx.projectDir,
    timeout: 180_000,
  });
}

/**
 * Tear the stack down. Volumes are kept unless explicitly asked for — they hold
 * the data, and losing them must be a decision rather than a side effect.
 */
export async function composeDown(ctx: ComposeContext, opts: { removeVolumes?: boolean } = {}): Promise<void> {
  const args = [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "down", "--remove-orphans"];
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
    [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "ps", "--format", "json", "-a"],
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

export async function composeLogs(ctx: ComposeContext, tail: number): Promise<string[]> {
  const result = await dockerTry(
    [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "logs", "--tail", String(tail), "--no-color"],
    { cwd: ctx.projectDir, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );
  return result ? lines(`${result.stdout}\n${result.stderr}`) : [];
}

export function composeFollow(ctx: ComposeContext, onLine: (line: string) => void): () => void {
  return dockerStream(
    [...baseArgs(ctx.slug, ctx.projectDir, ctx.file), "logs", "-f", "--tail", "0", "--no-color"],
    onLine
  );
}

/** Compose projects RunPanel owns, for the garbage collector. */
export async function listComposeProjects(): Promise<string[]> {
  const result = await dockerTry(["compose", "ls", "--all", "--format", "json"], { timeout: 30_000 });
  if (!result) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { Name?: string }[];
    return parsed.map((p) => p.Name ?? "").filter((n) => n.startsWith("runpanel-"));
  } catch {
    return [];
  }
}
