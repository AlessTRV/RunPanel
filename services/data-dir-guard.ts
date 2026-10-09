import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

/** Forward slashes, collapsed "//" and ".", no trailing slash. */
function clean(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/, "");
}

/** The path as typed, plus where it really leads when it exists on this host. */
function withRealpath(value: string): string[] {
  const out = [clean(value)];
  try {
    out.push(clean(fs.realpathSync(value)));
  } catch {
    /* does not exist (yet): the normalised path is all there is */
  }
  return out.filter(Boolean);
}

/**
 * Whether a host path is the panel's data directory, inside it, or above it.
 *
 * `<dataDir>/.secret` decrypts every credential the panel holds, so a bind of
 * any of the three hands it to the container. Both sides are normalised (Docker
 * collapses "//") and resolved through symlinks, so neither a doubled slash nor
 * a link to the data dir slips past.
 */
export function reachesDataDir(hostPath: string): boolean {
  if (!hostPath) return false;
  const targets = withRealpath(hostPath);
  const owns = withRealpath(config.dataDir);

  return owns.some((own) =>
    targets.some((target) => target === own || target.startsWith(`${own}/`) || own.startsWith(`${target}/`))
  );
}
