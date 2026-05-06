import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildEnv, getShellPath, isWindows } from "../env-utils";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

const exec = promisify(execFile);

const processName = (slug: string) => `runpanel-${slug}`;

/** Run a command through an explicit shell to avoid ENOENT on Windows */
function shellExec(command: string, options: Record<string, unknown> = {}) {
  const shell = getShellPath();
  const args = isWindows ? ["/c", command] : ["-c", command];
  return exec(shell, args, options as Parameters<typeof exec>[2]);
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
    const projectEnv = { ...opts.env, PORT: opts.port.toString(), NODE_ENV: opts.env.NODE_ENV || "production" };

    // Capture the FULL system PATH now (while we still have it)
    const systemPath = process.env.Path || process.env.PATH || "";

    // Split command into binary and args: "bun next start -p 3002" → ["bun", "next", "start", "-p", "3002"]
    const cmdParts = portAwareCmd.split(/\s+/);

    const wrapperContent = `const { execFile } = require("child_process");

// Inject full system PATH that PM2 strips during fork
process.env.Path = ${JSON.stringify(systemPath)};

// Set project environment variables
${Object.entries(projectEnv).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join("\n")}

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
    const ecosystem = {
      apps: [{
        name,
        script: wrapperFile,
        cwd: opts.cwd,
        autorestart: false,
        merge_logs: true,
      }],
    };

    fs.writeFileSync(ecosystemFile, JSON.stringify(ecosystem, null, 2));

    const { stdout: pm2Out, stderr: pm2Err } = await shellExec(
      `npx pm2 start ${ecosystemFile}`, { env, timeout: 30_000 }
    );

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
      await shellExec(`npx pm2 stop ${name}`, { timeout: 15_000 });
    } catch { /* might already be stopped */ }
  },

  async restart(slug: string): Promise<void> {
    const name = processName(slug);
    const ecosystemFile = path.join(config.dataDir, "pm2", `${slug}.json`);

    if (fs.existsSync(ecosystemFile)) {
      try {
        await shellExec(`npx pm2 delete ${name}`, { timeout: 10_000 });
      } catch { /* ignore */ }
      const env = buildEnv();
      await shellExec(`npx pm2 start ${ecosystemFile}`, { env, timeout: 30_000 });
    } else {
      await shellExec(`npx pm2 restart ${name}`, { timeout: 15_000 });
    }
  },

  async status(slug: string): Promise<ProcessInfo> {
    const name = processName(slug);
    try {
      const { stdout } = await shellExec("npx pm2 jlist", { timeout: 10_000 });
      const list = JSON.parse(stdout.toString());
      const proc = list.find((p: Record<string, unknown>) => p.name === name);

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
    } catch {
      return { running: false };
    }
  },

  async logs(slug: string, lines: number): Promise<string[]> {
    const name = processName(slug);
    try {
      const { stdout } = await shellExec(
        `npx pm2 logs ${name} --lines ${lines} --nostream`,
        { timeout: 10_000 }
      );
      return stdout.toString().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    const name = processName(slug);
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const logs = await pm2Driver.logs(slug, 5);
          logs.forEach((line) => callback(line, "stdout"));
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    poll();
    return () => { stopped = true; };
  },
};
