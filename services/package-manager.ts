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
}

/**
 * The order is the historical one and is deliberately not "best first": a
 * project with two lockfiles has already made a choice, and changing which one
 * wins would change how existing projects build.
 */
export function detectPackageManager(projectDir: string): PackageManager {
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", install: "pnpm install" };
  }
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) {
    return { cmd: "yarn", install: "yarn install" };
  }
  if (
    fs.existsSync(path.join(projectDir, "bun.lock")) ||
    fs.existsSync(path.join(projectDir, "bun.lockb"))
  ) {
    return { cmd: "bun", install: "bun install" };
  }
  return { cmd: "npm", install: "npm install" };
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
    manager: { cmd: "npm", install: "npm install" },
    detected: detected.cmd,
    fellBack: true,
  };
}
