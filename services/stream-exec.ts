import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip, createGzip } from "zlib";

/**
 * Run a program and stream its bulk output to a file, or a file to its stdin.
 *
 * The rest of the panel talks to child processes through `execFile`, which
 * collects everything in memory and gives up at `maxBuffer`. That is the right
 * shape for `docker inspect` and the wrong shape for `pg_dump`: a 200 MB dump
 * does not fail with a database error, it fails with ENOBUFS after doing all
 * the work.
 *
 * Nothing here knows about Docker. `services/docker/cli.ts` wraps it so docker
 * calls keep their own error type and sanitised environment, and the module
 * stays importable on its own — which is what lets the unit suite drive it with
 * `node` as the command, with no daemon and no server.
 */

/**
 * Fields are declared and assigned rather than written as constructor parameter
 * properties: Node's strip-only TypeScript loader rejects those, and the unit
 * suite imports this module directly rather than through a bundler.
 */
export class ExecStreamError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    command: string,
    args: string[],
    stderr: string,
    exitCode: number | null
  ) {
    super(message);
    this.name = "ExecStreamError";
    this.command = command;
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** Keep the end of a stream's diagnostics without letting them grow unbounded. */
class Tail {
  private text = "";
  private readonly limit: number;

  constructor(limit = 64 * 1024) {
    this.limit = limit;
  }

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.limit) {
      this.text = this.text.slice(this.text.length - this.limit);
    }
  }

  get value(): string {
    return this.text.trim();
  }
}

/** Feed complete lines to a callback, holding back a partial trailing line. */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trimEnd();
      if (line) onLine(line);
    }
  };
}

export interface ExecStreamOptions {
  cwd?: string;
  /** The complete environment for the child, not a set of additions. */
  env?: NodeJS.ProcessEnv;
  /**
   * Give up when not a single byte has moved for this long. There is no total
   * timeout on purpose — a legitimate dump of a large database can run for an
   * hour — but a command waiting on a lock that will never be released must not
   * hold the scheduler forever.
   */
  inactivityMs?: number;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ExecToFileOptions extends ExecStreamOptions {
  /** gzip on the way to disk. Skip it for output that is already compressed. */
  compress?: boolean;
  /**
   * Accept "exited 0, wrote nothing". Off by default because it is a real
   * failure mode: an image whose entrypoint swallows the error exits cleanly
   * having produced an empty dump, and an empty dump nobody notices is worse
   * than no dump at all.
   */
  allowEmpty?: boolean;
}

export interface ExecToFileResult {
  /** Bytes written to the destination, after compression. */
  bytes: number;
  /** Bytes read from the command, before compression. */
  rawBytes: number;
  /** sha256 of the file as written, so `sha256sum` on it agrees. */
  sha256: string;
  stderrTail: string;
}

export interface ExecFromFileOptions extends ExecStreamOptions {
  /** gunzip on the way in, for artifacts written with `compress`. */
  decompress?: boolean;
  onStdout?: (line: string) => void;
}

export const DEFAULT_INACTIVITY_MS = 10 * 60_000;

interface Watchdog {
  touch: () => void;
  stop: () => void;
  firedRef: { fired: boolean };
}

function startWatchdog(kill: () => void, inactivityMs: number): Watchdog {
  let last = Date.now();
  const firedRef = { fired: false };
  const timer = setInterval(() => {
    if (Date.now() - last < inactivityMs) return;
    firedRef.fired = true;
    kill();
  }, Math.min(inactivityMs, 30_000));
  timer.unref?.();
  return { touch: () => (last = Date.now()), stop: () => clearInterval(timer), firedRef };
}

function inactivityMessage(inactivityMs: number): string {
  return `No output for ${Math.round(inactivityMs / 1000)}s; the command was killed as hung`;
}

/** Run a command and write its stdout straight to a file. */
export async function execToFile(
  command: string,
  args: string[],
  destPath: string,
  opts: ExecToFileOptions = {}
): Promise<ExecToFileResult> {
  const child = spawn(command, args, { windowsHide: true, cwd: opts.cwd, env: opts.env });

  const stderr = new Tail();
  const onStderrLine = opts.onStderr ? lineSplitter(opts.onStderr) : null;

  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let rawBytes = 0;

  const inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const watchdog = startWatchdog(() => child.kill("SIGKILL"), inactivityMs);

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      rawBytes += chunk.length;
      watchdog.touch();
      cb(null, chunk);
    },
  });

  const digest = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    // Progress on stderr is a sign of life too: a command reporting rows dumped
    // is not hung, even while stdout stays quiet.
    watchdog.touch();
    stderr.push(text);
    onStderrLine?.(text);
  });

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const onAbort = () => child.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const stdout = child.stdout;
  if (!stdout) throw new Error(`${command} was spawned without a stdout pipe`);
  const sink = fs.createWriteStream(destPath, { mode: 0o600 });

  let pipelineError: unknown = null;
  try {
    await (opts.compress
      ? pipeline(stdout, counter, createGzip(), digest, sink)
      : pipeline(stdout, counter, digest, sink));
  } catch (err) {
    pipelineError = err;
    child.kill("SIGKILL");
  }

  const code = await exited;
  watchdog.stop();
  opts.signal?.removeEventListener("abort", onAbort);

  const fail = (message: string): never => {
    fs.rmSync(destPath, { force: true });
    throw new ExecStreamError(message, command, args, stderr.value, code);
  };

  if (spawnError) fail(`${command} could not be executed: ${(spawnError as Error).message}`);
  if (watchdog.firedRef.fired) fail(inactivityMessage(inactivityMs));
  // The exit code wins over a pipeline error: a command that died mid-stream
  // leaves an EPIPE here and the actual reason on its stderr, and reporting the
  // EPIPE would hide it.
  if (code !== 0) fail(stderr.value || `${command} exited with code ${code}`);
  if (pipelineError) {
    fail(pipelineError instanceof Error ? pipelineError.message : String(pipelineError));
  }
  if (bytes === 0 && !opts.allowEmpty) {
    fail("The command finished without an error but produced no data");
  }

  return { bytes, rawBytes, sha256: hash.digest("hex"), stderrTail: stderr.value };
}

/**
 * Run a command and feed it a file on stdin — the restore direction.
 *
 * The interesting case is a command that rejects its input and exits while we
 * are still writing: stdin then errors with EPIPE, which says nothing useful.
 * The child's exit code and stderr are what the operator needs, so an EPIPE is
 * recorded and only reported if the command somehow succeeded anyway.
 */
export async function execFromFile(
  command: string,
  args: string[],
  srcPath: string,
  opts: ExecFromFileOptions = {}
): Promise<{ stdoutTail: string; stderrTail: string }> {
  const child = spawn(command, args, { windowsHide: true, cwd: opts.cwd, env: opts.env });

  const stderr = new Tail();
  const stdout = new Tail(16 * 1024);
  const onStderrLine = opts.onStderr ? lineSplitter(opts.onStderr) : null;
  const onStdoutLine = opts.onStdout ? lineSplitter(opts.onStdout) : null;

  const inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const watchdog = startWatchdog(() => child.kill("SIGKILL"), inactivityMs);

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    watchdog.touch();
    stderr.push(text);
    onStderrLine?.(text);
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => {
    watchdog.touch();
    stdout.push(text);
    onStdoutLine?.(text);
  });

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const onAbort = () => child.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const stdin = child.stdin;
  if (!stdin) throw new Error(`${command} was spawned without a stdin pipe`);

  const source = fs.createReadStream(srcPath);
  source.on("data", watchdog.touch);

  let pipelineError: unknown = null;
  try {
    await (opts.decompress ? pipeline(source, createGunzip(), stdin) : pipeline(source, stdin));
  } catch (err) {
    pipelineError = err;
  }

  const code = await exited;
  watchdog.stop();
  opts.signal?.removeEventListener("abort", onAbort);

  const fail = (message: string): never => {
    throw new ExecStreamError(message, command, args, stderr.value, code);
  };

  if (spawnError) fail(`${command} could not be executed: ${(spawnError as Error).message}`);
  if (watchdog.firedRef.fired) fail(inactivityMessage(inactivityMs));
  if (code !== 0) fail(stderr.value || `${command} exited with code ${code}`);
  if (pipelineError) {
    fail(pipelineError instanceof Error ? pipelineError.message : String(pipelineError));
  }

  return { stdoutTail: stdout.value, stderrTail: stderr.value };
}
