import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildEnv, getShellPath, isWindows } from "../env-utils";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

const exec = promisify(execFile);

const processName = (slug: string) => `runpanel-${slug}`;

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
  return [".js", ".json", ".env.json", ".cmd", ".sh"].map((ext) => path.join(dir, `${slug}${ext}`));
}

export function removePm2Artifacts(slug: string): void {
  for (const file of pm2ArtifactPaths(slug)) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

/** Run a command through an explicit shell to avoid ENOENT on Windows */
function shellExec(command: string, options: Record<string, unknown> = {}) {
  const shell = getShellPath();
  const args = isWindows ? ["/c", command] : ["-c", command];
  return exec(shell, args, options as Parameters<typeof exec>[2]);
}

/**
 * Locate the pm2 binary once instead of going through `npx` on every call.
 *
 * `npx pm2 …` re-resolves the package on each invocation, which costs hundreds
 * of milliseconds — and `status()` was calling it on every status poll of every
 * project. Resolved lazily and cached for the process lifetime.
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
  pm2Command = fs.existsSync(local) ? `"${local}"` : "npx --no-install pm2";
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

async function pm2List(): Promise<Pm2Process[]> {
  if (jlistCache && Date.now() - jlistCache.at < JLIST_TTL_MS) return jlistCache.value;
  // Collapse concurrent callers onto one spawn rather than starting several.
  if (jlistInFlight) return jlistInFlight;

  jlistInFlight = (async () => {
    try {
      const { stdout } = await shellExec(`${resolvePm2Command()} jlist`, { timeout: 15_000 });
      const parsed = JSON.parse(stdout.toString()) as Pm2Process[];
      jlistCache = { at: Date.now(), value: parsed };
      return parsed;
    } catch {
      jlistCache = { at: Date.now(), value: [] };
      return [];
    } finally {
      jlistInFlight = null;
    }
  })();

  return jlistInFlight;
}

/** Any command that changes state must invalidate the cached listing. */
function invalidatePm2Cache(): void {
  jlistCache = null;
}

/**
 * Resolve the actual start command with explicit port flag.
 * Many frameworks (Next.js, Vite) ignore PORT env var.
 */
function resolveStartCmd(startCmd: string, cwd: string, port: number): string {
  if (startCmd.includes("-p ") || startCmd.includes("--port")) return startCmd;

  // For "pm run start", read package.json to get actual script and run directly
  const pmRunMatch = startCmd.match(/^(bun|npm|yarn|pnpm)\s+run\s+start$/);
  if (pmRunMatch) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      const script = pkg.scripts?.start as string | undefined;
      if (script && /^(next|vite|nuxt)\s+(start|preview|dev)/.test(script)) {
        return `${pmRunMatch[1]} ${script} -p ${port}`;
      }
    } catch { /* fallback */ }
  }

  // Direct "next start" etc
  if (/^(next|vite|nuxt)\s+(start|preview|dev)/.test(startCmd)) {
    return `${startCmd} -p ${port}`;
  }

  return startCmd;
}

export const pm2Driver: IProcessDriver = {
  async start(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
    const name = processName(slug);

    // Delete existing process if any
    try {
      await shellExec(`npx pm2 delete ${name}`, { timeout: 10_000 });
    } catch { /* ignore */ }

    // Build env with PATH protection
    const env = buildEnv({ ...opts.env, PORT: opts.port.toString() });

    const ecosystemDir = path.join(config.dataDir, "pm2");
    fs.mkdirSync(ecosystemDir, { recursive: true });

    const portAwareCmd = resolveStartCmd(startCmd, opts.cwd, opts.port);

    // Write a .js wrapper that PM2 can run natively.
    // PM2 strips the system PATH when forking, so spawn/exec with shell: true
    // fails with ENOENT on cmd.exe. The wrapper uses execFile with the command
    // split into binary + args, and injects the full system PATH.
    const wrapperFile = path.join(ecosystemDir, `${slug}.js`);
    const envDataFile = path.join(ecosystemDir, `${slug}.env.json`);
    const projectEnv = { ...opts.env, PORT: opts.port.toString(), NODE_ENV: opts.env.NODE_ENV || "production" };

    // Capture the FULL system PATH now (while we still have it)
    const systemPath = process.env.Path || process.env.PATH || "";

    // Split command into binary and args: "bun next start -p 3002" → ["bun", "next", "start", "-p", "3002"]
    const cmdParts = portAwareCmd.split(/\s+/);

    // Secrets go into a 0600 sidecar the wrapper reads at startup, not inlined
    // into the wrapper source. The generated .js used to contain every
    // environment variable of the project in cleartext, world-readable.
    fs.writeFileSync(envDataFile, JSON.stringify({ path: systemPath, env: projectEnv }), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envDataFile, 0o600);
    } catch {
      /* chmod is a no-op on some Windows filesystems */
    }

    const wrapperContent = `const { execFile } = require("child_process");
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
`;

    fs.writeFileSync(wrapperFile, wrapperContent);

    // Ecosystem file — PM2 runs the .js natively with Node.js
    const ecosystemFile = path.join(ecosystemDir, `${slug}.json`);
    const logDir = path.join(config.logsDir, "pm2");
    fs.mkdirSync(logDir, { recursive: true });

    const ecosystem = {
      apps: [{
        name,
        script: wrapperFile,
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
      const env = buildEnv();
      await shellExec(`${pm2} start ${ecosystemFile}`, { env, timeout: 60_000 });
    } else {
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
