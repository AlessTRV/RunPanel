import fs from "fs";
import os from "os";
import path from "path";

/**
 * Where the panel's tools actually live, and how to find them.
 *
 * Node builtins only, and no imports from the rest of the app — the unit suite
 * loads this file directly, and "which PATH does a spawned build get" is a
 * question that should be answerable without a server, a daemon or a host that
 * happens to have bun on it.
 */

const isWindows = os.platform() === "win32";

/**
 * Per-user bin directories, relative to the home directory.
 *
 * `~/.bun/bin` is the one that matters most here: it holds `bun` and `bunx`,
 * and every `bun add -g` links its binaries into it — pm2 included.
 */
const USER_BIN_DIRS = [
  ".bun/bin",
  ".local/bin",
  ".npm-global/bin",
  ".yarn/bin",
  ".deno/bin",
  ".cargo/bin",
];

/** Where a distribution puts things, for the case where PATH arrives narrow. */
const SYSTEM_BIN_DIRS = [
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
];

/**
 * The PATH a child process should get.
 *
 * A panel started from a login shell inherits that shell's PATH and everything
 * works. A panel started by systemd inherits PID 1's, which is
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin` and nothing
 * else — no `~/.bun/bin`, no nvm directory. So the same build command that ran
 * fine yesterday fails with `bun: command not found` and exit 127 the moment
 * autostart takes over, and the panel reports a broken build command when what
 * is actually broken is the environment it ran in. A unit file inherits nothing
 * from the shell that installed it, so this has to be reconstructed rather than
 * read back.
 *
 * The inherited entries stay first and in order — an operator who set a PATH
 * meant it — and the toolchain directories are appended after. The one worth
 * knowing about is `path.dirname(process.execPath)`: that is where the node
 * running this very process lives, which is nvm's versioned bin directory
 * without anyone having to guess the version number, and `npm` and `npx` come
 * along with it.
 *
 * The arguments exist for the tests; production always calls it with none.
 */
export function toolchainPath(
  inherited: string = process.env.PATH || process.env.Path || "",
  home: string = os.homedir(),
  nodeDir: string = path.dirname(process.execPath),
  exists: (dir: string) => boolean = isDirectory
): string {
  const entries = inherited.split(path.delimiter).filter(Boolean);
  const seen = new Set(entries);

  const candidates = [nodeDir, ...USER_BIN_DIRS.map((dir) => path.join(home, dir))];
  if (!isWindows) candidates.push(...SYSTEM_BIN_DIRS);

  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    // A directory that is not on this host would only slow every lookup down.
    if (exists(dir)) entries.push(dir);
  }

  return entries.join(path.delimiter);
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `which`, over the PATH the panel is about to hand out.
 *
 * Used to resolve a tool to an absolute path once, rather than hoping every
 * shell the panel spawns can find it by name. Returns null when the tool
 * genuinely is not installed — a different answer from "the PATH was wrong",
 * and one the diagnostics page is entitled to report differently.
 */
export function whichSync(name: string, searchPath: string = toolchainPath()): string | null {
  const names = isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];

  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        // `statSync` follows symlinks on purpose: `~/.bun/bin/pm2` is one.
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}
