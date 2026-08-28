import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createReporter } from "../harness.mjs";

/**
 * That the two lockfiles and `package.json` still tell the same story.
 *
 * RunPanel carries both `bun.lock` and `package-lock.json` on purpose: the
 * self-update picks its package manager from the lockfiles it finds and falls
 * back to npm on a server that has never had bun, so both have to describe the
 * same tree or the panel installs one thing here and another thing there.
 *
 * They stopped doing that once, and it was not visible from anywhere. A
 * dependency bump refreshed `bun.lock` and left `package-lock.json` on the
 * previous tree; the server installs with bun, so it quietly moved to HeroUI
 * 3.2 while the npm lockfile still said 3.0.3 — and 3.2 had moved the clickable
 * part of `Switch` into a subcomponent, so every toggle in the panel kept
 * rendering and stopped working. The same commit also left HeroUI's new
 * `react-aria` peers undeclared, which is not a drift but a wall: `npm install`
 * refuses the tree outright with ERESOLVE, so any host without bun would have
 * had its self-update die at the install step.
 *
 * Two facts are enough to catch both, and neither needs a network or a
 * `node_modules`: every declared dependency is resolved by both lockfiles, and
 * they resolve it to the same version.
 */
export const meta = { name: "dependencies-unit", needsDocker: false, drivers: [], standalone: true };

/**
 * `bun.lock` is JSONC — trailing commas, which `JSON.parse` refuses.
 *
 * Stripping them with a regex is safe here and nowhere near general: the file
 * holds package names, semver ranges and base64 hashes, none of which can
 * contain a comma followed by a closing brace.
 */
function readBunLock(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/,(\s*[}\]])/g, "$1"));
}

export async function run({ repoRoot }) {
  const r = createReporter("dependencies-unit");

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const npmLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const bunLock = readBunLock(join(repoRoot, "bun.lock"));

  const npmRoot = npmLock.packages?.[""] ?? {};
  const bunRoot = bunLock.workspaces?.[""] ?? {};

  for (const field of ["dependencies", "devDependencies"]) {
    const declared = pkg[field] ?? {};

    // --- the ranges each lockfile believes it was given ---------------------
    const npmRanges = Object.entries(declared).filter(([n, v]) => (npmRoot[field] ?? {})[n] !== v);
    r.check(
      `package-lock.json records the declared ${field}`,
      npmRanges.length === 0,
      npmRanges.map(([n, v]) => `${n}: package.json ${v}, lock ${(npmRoot[field] ?? {})[n]}`).join("; ")
    );

    const bunRanges = Object.entries(declared).filter(([n, v]) => (bunRoot[field] ?? {})[n] !== v);
    r.check(
      `bun.lock records the declared ${field}`,
      bunRanges.length === 0,
      bunRanges.map(([n, v]) => `${n}: package.json ${v}, lock ${(bunRoot[field] ?? {})[n]}`).join("; ")
    );

    // --- and the versions they picked ---------------------------------------
    const missing = [];
    const mismatched = [];

    for (const name of Object.keys(declared)) {
      const fromNpm = npmLock.packages?.[`node_modules/${name}`]?.version ?? null;

      // `["name@version", ...]`, where the name may be an alias — so the
      // version is what follows the last `@`, not the first.
      const bunEntry = bunLock.packages?.[name]?.[0] ?? null;
      const fromBun = bunEntry ? bunEntry.slice(bunEntry.lastIndexOf("@") + 1) : null;

      if (!fromNpm || !fromBun) {
        missing.push(`${name}: npm ${fromNpm ?? "—"}, bun ${fromBun ?? "—"}`);
      } else if (fromNpm !== fromBun) {
        mismatched.push(`${name}: npm ${fromNpm}, bun ${fromBun}`);
      }
    }

    r.check(`both lockfiles resolve every ${field}`, missing.length === 0, missing.join("; "));
    r.check(`both lockfiles agree on every ${field} version`, mismatched.length === 0, mismatched.join("; "));
  }

  /*
    A peer dependency HeroUI declares and package.json does not is the ERESOLVE
    above waiting to happen again. Read from the lockfile rather than from
    `node_modules`, so this holds on a checkout that has never been installed.
  */
  const heroui = npmLock.packages?.["node_modules/@heroui/react"];
  const peers = Object.keys(heroui?.peerDependencies ?? {});
  const reactAriaPeers = peers.filter((n) => n === "react-aria" || n.startsWith("@react-aria/") || n === "react-aria-components");
  const undeclared = reactAriaPeers.filter((n) => !(pkg.dependencies ?? {})[n]);

  r.check("HeroUI's react-aria peers are declared in package.json", undeclared.length === 0, undeclared.join(", "));
  r.check("the peer list was actually found", reactAriaPeers.length > 0, JSON.stringify(peers));

  return r.result();
}
