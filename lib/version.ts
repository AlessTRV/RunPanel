import fs from "fs";
import path from "path";

/**
 * Which RunPanel this is.
 *
 * Read from `package.json` rather than written down, because it was written
 * down: the sidebar rendered the literal `v0.1.0` and the backup manifest read
 * the real field, so the two could disagree and nobody would notice until an
 * archive said one thing and the screen another.
 *
 * `process.cwd()` is the panel's own directory — the same one
 * `services/autostart/probe.ts` puts in `WorkingDirectory=` and the same one
 * `services/panel-update/` updates. Cached because it cannot change without a
 * restart, and "sconosciuta" rather than a throw because a missing version is
 * never a reason to fail a request.
 */

let cached: string | null = null;

export function panelVersion(): string {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    cached = String((JSON.parse(raw) as { version?: string }).version ?? "sconosciuta");
  } catch {
    cached = "sconosciuta";
  }
  return cached;
}

export interface ReleaseParts {
  /** From `package.json`. The only part a human writes. */
  version: string;
  /** Commits on the mainline, or null when git could not say. */
  build: number | null;
  short: string | null;
}

/**
 * The version as one short string, for the footer of the sidebar.
 *
 * `v0.1.0` on its own answers nothing: it has said that since the first commit
 * and nothing bumps it, so it cannot tell you whether this is the same code you
 * looked at yesterday. The build number can, and it maintains itself.
 *
 * `+142` rather than `.142`, because that is semver's build-metadata separator
 * and it keeps the released version and the position in the history visibly
 * separate — the day somebody does tag `0.2.0`, the string still reads right.
 *
 * The sha is the fallback rather than an addition: it is seven characters that
 * mean nothing at a glance, worth showing only when there is no number.
 */
export function releaseLabel({ version, build, short }: ReleaseParts): string {
  if (build !== null) return `v${version}+${build}`;
  if (short) return `v${version} · ${short}`;
  return `v${version}`;
}
