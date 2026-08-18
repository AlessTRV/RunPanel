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
