import fs from "fs";
import path from "path";

/**
 * Which package manager a directory belongs to, decided by its lockfile.
 *
 * Lifted out of `services/builders/node-builder.ts` when the panel learned to
 * update itself, because the panel is also a Node project with a lockfile and
 * the two must not answer differently about the same directory.
 *
 * Node builtins only, no imports at all from the rest of the app, so the unit
 * suite can load this file directly the way it already does for `toolchain.ts`
 * and `autostart/render.ts`. That is also why `resolvePackageManager` takes its
 * `which` rather than reaching for one: importing it would drag in the whole
 * chain behind the `@/` alias, which Node's strip-only loader cannot follow.
 */

export interface PackageManager {
  /** The binary, for building a `<cmd> run <script>` line. */
  cmd: string;
  /** The whole install command, because npm and the rest do not agree on it. */
  install: string;
  /**
   * The same install, refusing to re-resolve anything the lockfile already
   * decided. Only the panel's own update uses it.
   *
   * A plain `bun install` is not a reproduction of the committed tree: when it
   * decides the lockfile is stale it re-resolves every caret range and rewrites
   * the lockfile in place. That is how the panel came to be running HeroUI
   * 3.2.4 while both lockfiles said 3.0.3 — and 3.2 had moved the clickable
   * part of `Switch` into a subcomponent, so every toggle in the panel rendered
   * correctly and did nothing. A dependency upgrade nobody asked for, applied
   * silently, on the machine, during an update about something else.
   *
   * npm is deliberately left alone. Its frozen install is `npm ci`, which
   * begins by deleting `node_modules` — and this install runs *inside the
   * running panel*, which resolves `better-sqlite3` and `pg` out of that
   * directory to serve the very page showing the update's progress. `npm
   * install` already honours a lockfile that is in sync, and
   * `tests/suites/dependencies-unit.mjs` is what keeps it in sync.
   */
  frozenInstall: string;
}

/**
 * The order is the historical one and is deliberately not "best first": a
 * project with two lockfiles has already made a choice, and changing which one
 * wins would change how existing projects build.
 */
export function detectPackageManager(projectDir: string): PackageManager {
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", install: "pnpm install", frozenInstall: "pnpm install --frozen-lockfile" };
  }
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) {
    return { cmd: "yarn", install: "yarn install", frozenInstall: "yarn install --frozen-lockfile" };
  }
  if (
    fs.existsSync(path.join(projectDir, "bun.lock")) ||
    fs.existsSync(path.join(projectDir, "bun.lockb"))
  ) {
    return { cmd: "bun", install: "bun install", frozenInstall: "bun install --frozen-lockfile" };
  }
  return { cmd: "npm", install: "npm install", frozenInstall: "npm install" };
}

/**
 * The same detection, but refusing to name a tool this host does not have.
 *
 * Only the self-update uses this, and it needs it because RunPanel's own
 * repository carries **both** `bun.lock` and `package-lock.json`. Detection
 * therefore says bun, which is right on the machine the lockfile was written on
 * and wrong on a server that only ever ran `npm install` — and there the
 * difference is an update that dies at its first step.
 *
 * A project build deliberately does *not* get this fallback: quietly installing
 * a bun project with npm would produce a different dependency tree than the
 * author committed, and failing loudly is the better answer there.
 */
export function resolvePackageManager(
  projectDir: string,
  /** `whichSync` in production; a stub in the tests. */
  search: (name: string) => string | null
): { manager: PackageManager; detected: string; fellBack: boolean } {
  const detected = detectPackageManager(projectDir);
  if (search(detected.cmd)) return { manager: detected, detected: detected.cmd, fellBack: false };

  return {
    manager: { cmd: "npm", install: "npm install", frozenInstall: "npm install" },
    detected: detected.cmd,
    fellBack: true,
  };
}
