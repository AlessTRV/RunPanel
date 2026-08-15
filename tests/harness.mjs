/**
 * Test harness.
 *
 * Every suite gets its OWN server on its OWN data directory. That is not
 * fastidiousness: several of these suites call `setup: true` or change the admin
 * password, so running them against a shared instance made later suites fail
 * for reasons that had nothing to do with the code under test. Isolation is what
 * makes a red result mean something.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The panel's own tool resolution, imported rather than reimplemented so the
// harness cannot drift from what the driver actually does.
import { whichSync } from "../services/toolchain.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let nextPort = 3900;

/** Drop and recreate the public schema, so each Postgres suite starts empty. */
async function resetPostgres(connectionString) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

export function allocatePort() {
  return nextPort++;
}

/**
 * First-run setup requires a token that the server otherwise mints at boot and
 * prints to its log. Pinning it here is what lets a suite claim its own panel;
 * `security.mjs` covers the case where the token is wrong or missing.
 */
export const SETUP_TOKEN = "test-setup-token";

/** Start a RunPanel server against a throwaway data directory. */
export async function startServer({ driver = "sqlite", databaseUrl, env = {} } = {}) {
  const port = allocatePort();
  const dataDir = mkdtempSync(join(tmpdir(), "runpanel-test-"));

  // SQLite gets isolation for free from a fresh data directory. Postgres does
  // not: the database outlives the server, so a suite that ran earlier would
  // leave an admin password behind and break the next one's first-run checks.
  if (driver === "postgres" && databaseUrl) await resetPostgres(databaseUrl);

  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RUNPANEL_DATA_DIR: dataDir,
      RUNPANEL_DB_DRIVER: driver,
      // The runner starts one server per suite on one machine. Left alone,
      // every one of them would begin sweeping Docker and dumping databases
      // underneath the suite that is trying to assert on them. A suite that
      // wants a scheduler turns it back on through `env`.
      RUNPANEL_DISABLE_SCHEDULERS: "1",
      RUNPANEL_SETUP_TOKEN: SETUP_TOKEN,
      ...(databaseUrl ? { RUNPANEL_DATABASE_URL: databaseUrl } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let log = "";
  child.stdout?.on("data", (d) => { log += d.toString(); });
  child.stderr?.on("data", (d) => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/check`);
      if (res.ok) {
        return {
          base,
          dataDir,
          port,
          getLog: () => log,
          async stop() {
            child.kill();
            // Next spawns a child of its own on Windows; make sure the port frees.
            if (process.platform === "win32") {
              try {
                execFileSync("powershell", [
                  "-NoProfile", "-Command",
                  `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
                ], { stdio: "ignore" });
              } catch { /* already gone */ }
            }
            await new Promise((r) => setTimeout(r, 300));
            try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* held open */ }
          },
        };
      }
    } catch { /* not up yet */ }
    await sleep(400);
  }

  child.kill();
  throw new Error(`Server did not start on ${port}.\n${log.slice(-2000)}`);
}

/** A cookie jar, so a suite can act as several independent devices. */
export function client(base) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async call(path, init = {}) {
      const res = await fetch(base + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(init.headers ?? {}),
        },
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function docker(...args) {
  try {
    return execFileSync("docker", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function dockerAvailable() {
  return docker("version", "--format", "{{.Server.Version}}").length > 0;
}

/**
 * Is PM2 reachable the way the driver reaches it?
 *
 * Deliberately mirrors `resolvePm2Command()` in `pm2-driver.ts`: a vendored
 * binary first, then one resolved off the repaired PATH, and `npx --no-install`
 * only as a last resort. Probing with anything else would answer a different
 * question from the one the panel asks — and `npx` alone answers it wrongly,
 * since `npm exec` never searches PATH, so a `bun add -g pm2` in `~/.bun/bin`
 * reads as "pm2 not installed" on a host where it is running projects.
 *
 * `shell` on Windows because the resolved binary may be `npx.cmd`, which
 * `execFileSync` cannot launch directly.
 */
export function pm2Available() {
  const vendored = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "pm2.cmd" : "pm2");
  const onPath = whichSync("pm2");
  const [command, args] = existsSync(vendored)
    ? [vendored, ["-v"]]
    : onPath
      ? [onPath, ["-v"]]
      : ["npx", ["--no-install", "pm2", "-v"]];

  try {
    execFileSync(command, args, {
      stdio: "ignore",
      timeout: 60_000,
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    return false;
  }
}

/** Poll a project until it leaves the `deploying` state. */
export async function waitForDeploy(api, projectId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api.call(`/api/projects/${projectId}`);
    if (res.body?.status && res.body.status !== "deploying") return res.body.status;
    await sleep(1000);
  }
  return "timeout";
}

/** Collector for a suite's assertions. */
export function createReporter(name) {
  let passed = 0;
  const failures = [];

  return {
    check(description, ok, detail = "") {
      if (ok) {
        passed++;
        console.log(`    ok   ${description}`);
      } else {
        failures.push({ description, detail });
        console.log(`    FAIL ${description}${detail ? `  <- ${detail}` : ""}`);
      }
    },
    note(message) {
      console.log(`         ${message}`);
    },
    result() {
      return { name, passed, failed: failures.length, failures };
    },
  };
}
