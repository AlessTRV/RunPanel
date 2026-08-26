import fs from "fs";
import path from "path";

/**
 * Containment checks for every path that comes from outside the panel.
 *
 * Server-only, and in its own file for that reason: `lib/utils.ts` is imported
 * by client components, so it cannot pull in `fs`.
 *
 * This replaces four hand-written copies of the same check, two of which were
 * subtly different. Both mistakes they shared are worth naming, because both
 * read as correct:
 *
 *  - `resolved.startsWith(base)` is true for `/data/repos/app-evil` when base
 *    is `/data/repos/app`. The separator has to be part of the comparison.
 *  - `path.resolve` does not follow symlinks. A link committed to a repository
 *    — git preserves them, and `tar -xf` recreates them from a ZIP — resolves
 *    to a path under the repo and passes, while the read or write that follows
 *    lands wherever the link points. `fs.realpathSync` is what closes it.
 *
 * And a third, which the first version of this file got wrong: a **dangling**
 * link is invisible to `fs.existsSync`, because that follows the link and finds
 * nothing. Treated as a missing file it was re-attached to a resolved parent
 * and passed containment — and `writeFileSync` on a dangling link creates the
 * link's target. The walk below therefore asks `lstat`, not `stat`.
 */

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** `realpath`, falling back to the input for a path that does not exist yet. */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Whether anything sits at this path, INCLUDING a symlink whose target is gone.
 *
 * `fs.existsSync` uses `stat`, which follows links, so it answers false for a
 * dangling one. That was the whole bug this replaces: a dangling link counted
 * as a missing file, its name was re-attached to a resolved parent, containment
 * passed, and the write that followed landed wherever the link pointed.
 * `lstat` looks at the link itself.
 */
function lexists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `relative` inside `base`, following symlinks, or null if it escapes.
 *
 * The target of a write does not have to exist, so the deepest ancestor that
 * *does* exist is the one resolved for real; the rest is re-attached after.
 * That is what stops `existing-symlink/newfile` from being written through the
 * link.
 *
 * Inherently a check-then-use: a link created between this call and the open
 * that follows would not be seen. Closing that needs `O_NOFOLLOW` on every
 * call site, which is not worth it against an attacker who must already be
 * authenticated to reach any of them.
 */
export function resolveInside(base: string, relative: string): string | null {
  if (relative.includes("\0")) return null;

  // A leading slash means "root of the project", not "root of the disk".
  const cleaned = relative.replace(/^[/\\]+/, "");
  if (/^[A-Za-z]:/.test(cleaned)) return null;

  const root = realpathOrSelf(path.resolve(base));
  const target = path.resolve(root, cleaned);

  let existing = target;
  const missing: string[] = [];
  while (!lexists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  /*
    Resolved for real, and a failure here is a refusal rather than a fallback.

    `realpathOrSelf` cannot be used: it hands back its input, and for a dangling
    symlink the input is the link's own path — which sits inside the root and
    sails through the check below. A link that cannot be resolved is a link
    nobody can vouch for, so it does not get to be a destination.
  */
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    return null;
  }

  const resolved = path.join(real, ...missing);
  return isInside(root, resolved) ? resolved : null;
}

/**
 * The shape check for a path arriving in a query string or a JSON body, before
 * it is joined to anything. Cheap, and it keeps obviously hostile input from
 * reaching the filesystem at all — but it is not the containment check, and on
 * its own it never was: it says nothing about symlinks.
 */
export function isPathShapeSafe(relPath: string): boolean {
  if (relPath === "/" || relPath === "") return true;
  if (relPath.includes("\0")) return false;

  const cleaned = relPath.replace(/^[/\\]+/, "");
  if (/^[A-Za-z]:/.test(cleaned)) return false;

  const normalized = path.normalize(cleaned);
  return !path.isAbsolute(normalized) && !normalized.split(/[/\\]/).includes("..");
}
