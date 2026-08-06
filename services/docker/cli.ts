import { execFile, spawn } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * The one place RunPanel talks to Docker.
 *
 * Every call goes through here as an argv array — never a shell string. Two of
 * the previous call sites built shell strings (`docker build -t ${name} .`),
 * which is both an injection surface and a quoting hazard on Windows.
 */

export class DockerError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = "DockerError";
  }
}

export interface DockerOptions {
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export async function docker(args: string[], opts: DockerOptions = {}) {
  try {
    const { stdout, stderr } = await exec("docker", args, {
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; code?: number };
    const stderr = (e.stderr ?? "").toString().trim();
    throw new DockerError(
      stderr || e.message || `docker ${args[0]} failed`,
      args,
      stderr,
      typeof e.code === "number" ? e.code : null
    );
  }
}

/**
 * For calls whose failure is an expected outcome — removing something that may
 * already be gone. Returns null instead of throwing, so callers stop writing
 * empty catch blocks that also swallow real errors.
 */
export async function dockerTry(args: string[], opts: DockerOptions = {}) {
  try {
    return await docker(args, opts);
  } catch {
    return null;
  }
}

/** Split stdout into non-empty trimmed lines. */
export function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * `docker stats` emits ANSI cursor codes even when stdout is not a TTY: every
 * refresh cycle begins with a cursor-home sequence. Anything parsing its output
 * has to strip them first, or the first line of each cycle fails to parse.
 *
 * The escape byte is spelled as a \u escape rather than pasted in literally — a
 * raw control character in source is the kind of thing an editor or a diff
 * quietly eats. It also has to be part of the pattern: matching only the
 * bracket half would swallow ordinary text such as "[Hello" out of a log line.
 */
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*[A-Za-z]", "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Run a long-lived docker command, delivering complete lines. Returns a stop
 * function; the process is killed and no further callbacks fire after it.
 */
export function dockerStream(
  args: string[],
  onLine: (line: string) => void,
  onExit?: (code: number | null) => void
): () => void {
  const child = spawn("docker", args, { windowsHide: true });
  let stopped = false;
  let buffer = "";

  const handle = (chunk: Buffer) => {
    if (stopped) return;
    buffer += stripAnsi(chunk.toString());
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line) onLine(line);
    }
  };

  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);
  child.on("exit", (code) => {
    if (!stopped) onExit?.(code);
  });
  child.on("error", () => {
    if (!stopped) onExit?.(null);
  });

  return () => {
    stopped = true;
    child.kill();
  };
}

let availability: { checked: number; available: boolean } | null = null;

/** Whether the docker CLI is usable, cached briefly so UI polls stay cheap. */
export async function isDockerAvailable(): Promise<boolean> {
  const now = Date.now();
  if (availability && now - availability.checked < 30_000) return availability.available;

  const result = await dockerTry(["version", "--format", "{{.Server.Version}}"], {
    timeout: 5_000,
  });
  availability = { checked: now, available: result !== null };
  return availability.available;
}
