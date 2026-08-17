import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildEnv, getShellPath, isWindows, toolchainPath, whichSync } from "../env-utils";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

const exec = promisify(execFile);

const processName = (slug: string) => `runpanel-${slug}`;

/**
 * Quote a value for a POSIX shell.
 *
 * Everything between single quotes is literal, so the only character that needs
 * work is the quote itself: close, escape, reopen. Values here are the project's
 * environment — newlines (a PEM key), `$`, backticks, quotes — and every one of
 * them has to arrive at the app byte for byte. A value mangled on the way in
 * fails much later and much more quietly than a syntax error would.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What `KEY=value` in a sourced file can actually set. A name outside this shape
 * is not assignable by any POSIX shell, so it gets skipped rather than turned
 * into a syntax error that would take the whole app down — and the wrapper says
 * so on stderr, because a silently missing variable is the worse failure.
 */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every file the PM2 driver generates for a project.
 *
 * Defined here, next to the code that writes them, so a new artefact cannot be
 * added without the deletion path knowing about it — which is exactly how the
 * 0600 env sidecar would otherwise have been left behind on disk, full of the
 * project's secrets, after the project was deleted.
 */
export function pm2ArtifactPaths(slug: string): string[] {
  const dir = path.join(config.dataDir, "pm2");
  return [".js", ".json", ".env.json", ".env.sh", ".cmd", ".sh"]
    .map((ext) => path.join(dir, `${slug}${ext}`));
}

/** Generated files and process logs both go: neither outlives the project. */
export function removePm2Artifacts(slug: string): void {
  for (const file of [...pm2ArtifactPaths(slug), ...pm2LogPaths(slug)]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

function pm2LogPaths(slug: string): string[] {
  return [pm2LogFile(slug, "out"), pm2LogFile(slug, "error")];
}

/**
 * Empty the log files before a run starts — see `run-log.ts` for why the output
 * of the previous run must not survive into the next one. It also puts a ceiling
 * back on files that nothing ever rotated.
 *
 * Truncated rather than deleted, so a handle that outlives the process it
 * belonged to keeps appending into the file being read instead of into an
 * unlinked one nobody can see. Called after the old process is gone, so in
 * practice nothing is writing at that moment either way.
 */
function truncateLogs(slug: string): void {
  for (const file of pm2LogPaths(slug)) {
    try {
      if (fs.existsSync(file)) fs.truncateSync(file, 0);
    } catch {
      /* a log that cannot be emptied is not worth failing a deploy over */
    }
  }
}

/** Run a command through an explicit shell to avoid ENOENT on Windows */
function shellExec(command: string, options: Record<string, unknown> = {}) {
  const shell = getShellPath();
  const args = isWindows ? ["/c", command] : ["-c", command];
  // See the note in `run-command.ts`: Node's default quoting is wrong for
  // cmd.exe. It bites here whenever the pm2 binary is vendored, because then
  // `resolvePm2Command()` returns a quoted path and every pm2 call carries a
  // double quote.
  const windowsArgs = isWindows ? { windowsVerbatimArguments: true } : {};
  return exec(shell, args, { ...windowsArgs, ...options } as Parameters<typeof exec>[2]);
}

/**
 * Locate the pm2 binary once instead of going through `npx` on every call.
 *
 * `npx pm2 …` re-resolves the package on each invocation, which costs hundreds
 * of milliseconds — and `status()` was calling it on every status poll of every
 * project. Resolved lazily and cached for the process lifetime.
 *
 * Order matters. A vendored pm2 wins, then one found on the repaired PATH — see
 * `toolchainPath()` — and only then `npx`. The npx fallback is genuinely last
 * because it is the one that cannot work when it is needed most: `npm exec`
 * searches the project's `node_modules/.bin` and its own cache, not PATH, so a
 * pm2 installed with `bun add -g` (which lands in `~/.bun/bin`, not npm's
 * global prefix) is invisible to it. Under systemd that produced
 * `npx: command not found` at every project start, with pm2 sitting installed
 * and working two directories away.
 */
let pm2Command: string | null = null;

function resolvePm2Command(): string {
  if (pm2Command) return pm2Command;

  const local = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    isWindows ? "pm2.cmd" : "pm2"
  );

  // A local install is both faster and more predictable than whatever `npx`
  // decides to fetch; fall back to it only if pm2 is not vendored.
  const resolved = fs.existsSync(local) ? local : whichSync("pm2");
  pm2Command = resolved ? `"${resolved}"` : "npx --no-install pm2";
  return pm2Command;
}

/**
 * `pm2 jlist` is the only way to read process state, and it is not cheap.
 * Status is polled per project, so a short shared cache turns N spawns per tick
 * into one.
 */
interface Pm2Process {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; pm_uptime?: number };
  monit?: { memory?: number; cpu?: number };
}

let jlistCache: { at: number; value: Pm2Process[] } | null = null;
let jlistInFlight: Promise<Pm2Process[]> | null = null;
const JLIST_TTL_MS = 1500;

/**
 * Bumped by every state-changing command. A listing already in flight when the
 * change happened describes the world before it, so its result must not be
 * written to the cache afterwards.
 */
let jlistGeneration = 0;

function readPm2List(): Promise<Pm2Process[]> {
  const generation = jlistGeneration;

  const promise = (async (): Promise<Pm2Process[]> => {
    let value: Pm2Process[] = [];
    try {
      const { stdout } = await shellExec(`${resolvePm2Command()} jlist`, { timeout: 15_000 });
      value = JSON.parse(stdout.toString()) as Pm2Process[];
    } catch {
      /* pm2 missing, or listing mid-write: an empty listing is the honest answer */
    }
    if (generation === jlistGeneration) jlistCache = { at: Date.now(), value };
    return value;
  })().finally(() => {
    if (jlistInFlight === promise) jlistInFlight = null;
  });

  return promise;
}

/**
 * Served stale-while-revalidate, the same shape as `diskUsage()` in
 * host-metrics: measured here, the spawn costs ~800ms when pm2 is not vendored
 * and has to be resolved through npx, and status is polled every 5 seconds —
 * longer than the TTL, so a plain expiring cache never once hit. Only the very
 * first caller waits; after that a poll is served from memory while the refresh
 * lands in the background.
 */
async function pm2List(): Promise<Pm2Process[]> {
  if (jlistCache && Date.now() - jlistCache.at < JLIST_TTL_MS) return jlistCache.value;

  // Collapse concurrent callers onto one spawn rather than starting several.
  if (!jlistInFlight) jlistInFlight = readPm2List();

  // Nothing cached — first call of the process, or a state change just dropped
  // it — so this caller does have to wait for a real listing.
  if (!jlistCache) return jlistInFlight;

  return jlistCache.value;
}

/** Any command that changes state must invalidate the cached listing. */
function invalidatePm2Cache(): void {
  jlistGeneration++;
  jlistCache = null;
  // A listing started before the change cannot answer for after it, so it must
  // not be handed to the next caller either.
  jlistInFlight = null;
}

/**
 * Resolve the actual start command with explicit port flag.
 * Many frameworks (Next.js, Vite) ignore PORT env var.
 *
 * `bindHost` is set only when the panel's gate is going in front, and the same
 * reasoning applies to it twice over: a CLI that ignores `PORT` also ignores
 * `HOST`, and there the flag is the difference between an app on loopback and
 * an app still listening on every interface — which would leave a way past the
 * gate. The env vars are set too, for everything that does read them.
 */
function resolveStartCmd(startCmd: string, cwd: string, port: number, bindHost?: string): string {
  const withFlags = (cmd: string): string => {
    const binary = cmd.split(/\s+/)[0];
    // Only where the spelling is known. Guessing a flag a CLI does not have
    // turns a restriction into an app that will not boot.
    const host = !bindHost
      ? ""
      : binary === "next"
        ? ` -H ${bindHost}`
        : binary === "vite"
          ? ` --host ${bindHost}`
          : "";
    return `${cmd} -p ${port}${host}`;
  };

  if (startCmd.includes("-p ") || startCmd.includes("--port")) return startCmd;

  // `serve` publishes a static build, and its listen flag takes a full address:
  // the only way to pin a static site to loopback. The trailing `-l` is stripped
  // because the static builder used to emit one with no value after it, and
  // deployments recorded before that was fixed still carry it.
  if (/(^|\s)serve(\s|$)/.test(startCmd)) {
    const cleaned = startCmd.replace(/\s+-l\s*$/, "");
    return `${cleaned} -l ${bindHost ? `tcp://${bindHost}:${port}` : port}`;
  }

  // For "pm run start", read package.json to get actual script and run directly
  const pmRunMatch = startCmd.match(/^(bun|npm|yarn|pnpm)\s+run\s+start$/);
  if (pmRunMatch) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      const script = pkg.scripts?.start as string | undefined;
      if (script && /^(next|vite|nuxt)\s+(start|preview|dev)/.test(script)) {
        return `${pmRunMatch[1]} ${withFlags(script)}`;
      }
    } catch { /* fallback */ }
  }

  // Direct "next start" etc
  if (/^(next|vite|nuxt)\s+(start|preview|dev)/.test(startCmd)) {
    return withFlags(startCmd);
  }

  return startCmd;
}

export const pm2Driver: IProcessDriver = {
  async start(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
    const name = processName(slug);

    // Delete existing process if any
    try {
      await shellExec(`${resolvePm2Command()} delete ${name}`, { timeout: 30_000 });
    } catch { /* ignore */ }

    // After the old process is gone, so nothing is still appending to a file we
    // are emptying.
    truncateLogs(slug);

    // Where the app actually listens. Under a gate that is a loopback port the
    // operator never sees; `opts.port` stays the one every URL names.
    const listenOn = opts.loopbackPort ?? opts.port;
    const bindHost = opts.loopbackPort ? "127.0.0.1" : undefined;
    // `HOSTNAME` as well as `HOST`: it is the one Next reads, and it is the
    // framework most likely to be behind this. Set only while restricted, since
    // it also shadows the machine name for anything that logs it.
    const bindEnv: Record<string, string> = bindHost ? { HOST: bindHost, HOSTNAME: bindHost } : {};

    // Build env with PATH protection
    const env = buildEnv({ ...opts.env, ...bindEnv, PORT: listenOn.toString() });

    const ecosystemDir = path.join(config.dataDir, "pm2");
    fs.mkdirSync(ecosystemDir, { recursive: true });

    const portAwareCmd = resolveStartCmd(startCmd, opts.cwd, listenOn, bindHost);

    // The wrapper PM2 actually runs.
    //
    // On POSIX it is a shell script that `exec`s the command, so the shell is
    // REPLACED by the app and PM2 ends up holding the pid of the real process.
    // It used to be a Node wrapper that spawned the command as a child instead,
    // and that cost twice: a whole Node runtime per project doing nothing but
    // exporting variables (66 MB RSS, measured), and a PM2 pointed at the
    // wrapper rather than at the app. Everything PM2 does per-process was
    // therefore aimed at the wrong target — `max_memory_restart` below watched a
    // process that never grows, the panel's memory column read 64 MB for an app
    // using 414, and stop signals arrived at the parent instead of the app.
    //
    // On Windows it stays the Node wrapper: PM2 strips the system PATH when
    // forking, so spawn/exec with shell: true fails with ENOENT on cmd.exe, and
    // there is no Windows here to test a replacement on.
    const wrapperFile = path.join(ecosystemDir, `${slug}${isWindows ? ".js" : ".sh"}`);
    const envDataFile = path.join(ecosystemDir, `${slug}${isWindows ? ".env.json" : ".env.sh"}`);
    const projectEnv = {
      ...opts.env,
      ...bindEnv,
      PORT: listenOn.toString(),
      NODE_ENV: opts.env.NODE_ENV || "production",
    };

    // Capture the FULL system PATH now (while we still have it), repaired the
    // same way every other child process gets it — the panel's own PATH is
    // PID 1's when systemd started it, and the wrapper would otherwise hand a
    // project a PATH with neither bun nor node on it.
    const systemPath = toolchainPath();

    // Split command into binary and args: "bun next start -p 3002" → ["bun", "next", "start", "-p", "3002"]
    const cmdParts = portAwareCmd.split(/\s+/);

    // Secrets go into a 0600 sidecar the wrapper reads at startup, not inlined
    // into the wrapper source. The generated wrapper used to contain every
    // environment variable of the project in cleartext, world-readable.
    const unassignable: string[] = [];
    const envContent = isWindows
      ? JSON.stringify({ path: systemPath, env: projectEnv })
      : [
        "# Generato da RunPanel a ogni avvio del progetto: viene riscritto, non",
        "# modificarlo a mano. Lo legge il wrapper con `set -a`, non l'app.",
        `PATH=${shQuote(systemPath)}`,
        ...Object.entries(projectEnv).flatMap(([key, value]) => {
          if (!SHELL_NAME.test(key)) {
            unassignable.push(key);
            return [];
          }
          return [`${key}=${shQuote(String(value))}`];
        }),
        "",
      ].join("\n");

    fs.writeFileSync(envDataFile, envContent, { mode: 0o600 });
    try {
      fs.chmodSync(envDataFile, 0o600);
    } catch {
      /* chmod is a no-op on some Windows filesystems */
    }

    const wrapperContent = isWindows
      ? `const { execFile } = require("child_process");
const { readFileSync } = require("fs");

// Environment is read from a 0600 sidecar rather than inlined here, so this
// file never contains the project's secrets.
const config = JSON.parse(readFileSync(${JSON.stringify(envDataFile)}, "utf8"));

// PM2 strips the system PATH when forking; put it back.
process.env.Path = config.path;
process.env.PATH = config.path;
for (const [key, value] of Object.entries(config.env)) process.env[key] = value;

const child = execFile(${JSON.stringify(cmdParts[0])}, ${JSON.stringify(cmdParts.slice(1))}, {
  cwd: ${JSON.stringify(opts.cwd)},
  env: process.env,
  maxBuffer: 50 * 1024 * 1024,
  windowsHide: true,
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("exit", (code) => process.exit(code || 0));
child.on("error", (e) => { console.error("Process error:", e.message); process.exit(1); });
`
      : [
        "#!/bin/bash",
        "# Generato da RunPanel a ogni avvio del progetto: viene riscritto, non",
        "# modificarlo a mano.",
        ...unassignable.map((key) =>
          `echo ${shQuote(`[runpanel] variabile ignorata, il nome non e' assegnabile da una shell: ${key}`)} >&2`
        ),
        "",
        "# `set -a` esporta tutto quello che il sidecar assegna; senza, le",
        "# variabili resterebbero locali alla shell e l'app non ne vedrebbe una.",
        "set -a",
        `. ${shQuote(envDataFile)} || { echo ${shQuote("[runpanel] sidecar dell'ambiente illeggibile")} >&2; exit 1; }`,
        "set +a",
        `cd ${shQuote(opts.cwd)} || exit 1`,
        "",
        "# `exec`: da qui in poi questo pid E' l'applicazione. E' tutto il punto",
        "# del wrapper — vedi il commento sopra, in pm2-driver.ts.",
        `exec ${cmdParts.map(shQuote).join(" ")}`,
        "",
      ].join("\n");

    fs.writeFileSync(wrapperFile, wrapperContent, { mode: isWindows ? 0o644 : 0o700 });

    // A project started before the driver changed wrapper flavour still has the
    // other flavour on disk, and the Node one comes with a `.env.json` holding
    // every secret of the project in cleartext. Whatever we are not writing goes.
    for (const stale of isWindows
      ? [`${slug}.sh`, `${slug}.env.sh`]
      : [`${slug}.js`, `${slug}.env.json`]) {
      fs.rmSync(path.join(ecosystemDir, stale), { force: true });
    }

    // Ecosystem file — PM2 runs the .js natively with Node.js, and needs to be
    // told which interpreter the shell wrapper wants.
    const ecosystemFile = path.join(ecosystemDir, `${slug}.json`);
    const logDir = path.join(config.logsDir, "pm2");
    fs.mkdirSync(logDir, { recursive: true });

    const ecosystem = {
      apps: [{
        name,
        script: wrapperFile,
        ...(isWindows ? {} : { interpreter: "bash" }),
        cwd: opts.cwd,
        // Restart on crash, matching the Docker driver's default. `false` meant
        // a process that died stayed dead until someone noticed.
        autorestart: opts.restartPolicy !== "no",
        max_restarts: 10,
        min_uptime: 5000,
        // Explicit paths so log tailing does not depend on where pm2 keeps its
        // home directory.
        out_file: pm2LogFile(slug, "out"),
        error_file: pm2LogFile(slug, "error"),
        merge_logs: true,
        ...(opts.memory ? { max_memory_restart: opts.memory } : {}),
      }],
    };

    fs.writeFileSync(ecosystemFile, JSON.stringify(ecosystem, null, 2));

    const { stdout: pm2Out, stderr: pm2Err } = await shellExec(
      `${resolvePm2Command()} start ${ecosystemFile}`, { env, timeout: 60_000 }
    );
    invalidatePm2Cache();

    if (opts.onLog) {
      const out = pm2Out?.toString().trim();
      const err = pm2Err?.toString().trim();
      if (out) opts.onLog(`[pm2] ${out}`);
      if (err) opts.onLog(`[pm2 stderr] ${err}`);
    }
  },

  async stop(slug: string): Promise<void> {
    const name = processName(slug);
    try {
      await shellExec(`${resolvePm2Command()} delete ${name}`, { timeout: 30_000 });
    } catch { /* might already be stopped/deleted */ }
    invalidatePm2Cache();
  },

  async remove(slug: string): Promise<void> {
    // PM2 has no separate notion here: `delete` already removes the process
    // entry, and the generated files are cleaned up by the caller.
    await pm2Driver.stop(slug);
  },

  async restart(slug: string): Promise<void> {
    const name = processName(slug);
    const ecosystemFile = path.join(config.dataDir, "pm2", `${slug}.json`);
    const pm2 = resolvePm2Command();

    if (fs.existsSync(ecosystemFile)) {
      try {
        await shellExec(`${pm2} delete ${name}`, { timeout: 30_000 });
      } catch { /* ignore */ }
      truncateLogs(slug);
      const env = buildEnv();
      await shellExec(`${pm2} start ${ecosystemFile}`, { env, timeout: 60_000 });
    } else {
      truncateLogs(slug);
      await shellExec(`${pm2} restart ${name}`, { timeout: 30_000 });
    }
    invalidatePm2Cache();
  },

  async status(slug: string): Promise<ProcessInfo> {
    const name = processName(slug);
    const proc = (await pm2List()).find((p) => p.name === name);

    if (!proc) return { running: false };

    return {
      running: proc.pm2_env?.status === "online",
      pid: proc.pid,
      uptime: proc.pm2_env?.pm_uptime
        ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000)
        : undefined,
      memory: proc.monit?.memory,
      cpu: proc.monit?.cpu,
    };
  },

  async logs(slug: string, lines: number): Promise<string[]> {
    // Read the log files directly rather than shelling out to `pm2 logs`,
    // which starts a whole pm2 client just to print a tail.
    const collected: string[] = [];
    for (const file of [pm2LogFile(slug, "out"), pm2LogFile(slug, "error")]) {
      if (!fs.existsSync(file)) continue;
      try {
        const content = fs.readFileSync(file, "utf8");
        collected.push(...content.split("\n").filter(Boolean));
      } catch {
        /* a log being written to mid-read is not worth failing over */
      }
    }
    return collected.slice(Math.max(0, collected.length - lines));
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    // The previous implementation re-read the last 5 lines every 2 seconds and
    // pushed them all again, so the UI had to de-duplicate with a Set — which
    // in turn silently dropped legitimately repeated lines. Following the files
    // by byte offset emits each line exactly once.
    const stopOut = tailFile(pm2LogFile(slug, "out"), (line) => callback(line, "stdout"));
    const stopErr = tailFile(pm2LogFile(slug, "error"), (line) => callback(line, "stderr"));

    return () => {
      stopOut();
      stopErr();
    };
  },
};

function pm2LogFile(slug: string, kind: "out" | "error"): string {
  return path.join(config.logsDir, "pm2", `${slug}-${kind}.log`);
}

/**
 * Follow a file from its current end, delivering complete lines.
 *
 * Polls `stat` rather than using fs.watch: watch semantics differ per platform
 * and miss appends on some network and Windows filesystems, and a stat every
 * 500ms is far cheaper than what this replaces.
 */
function tailFile(file: string, onLine: (line: string) => void, intervalMs = 500): () => void {
  let offset = 0;
  let stopped = false;
  let carry = "";

  try {
    offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    offset = 0;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // not created yet
    }

    // Truncated or rotated — start over from the beginning.
    if (size < offset) offset = 0;
    if (size === offset) return;

    try {
      const fd = fs.openSync(file, "r");
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      offset = size;

      carry += buffer.toString("utf8");
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) onLine(part);
      }
    } catch {
      /* try again on the next tick */
    }
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
