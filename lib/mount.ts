/**
 * Reading a Docker `-v` mapping.
 *
 * Two functions, no imports, for the reason `lib/git-ref.ts` has none: the rule
 * they encode is the difference between a directory the operator owns and a
 * volume the panel may delete, and a rule that decides that must be checkable
 * without a database, a daemon or a server.
 *
 * The bug they replace was two independent copies of `mapping.split(":")[0]`,
 * one in `provisionService` and one in `serviceVolumeNames`. On a POSIX host it
 * is right. On Windows the first colon belongs to the drive letter, so
 * `C:\dati:/var/lib/postgresql` answered `"C"` — which then looked like a
 * RunPanel-owned volume name to create, and, on a delete-with-data, to remove.
 */

/** True for `C:\…`, `C:/…` and `c:…`; a volume name can never look like this. */
const DRIVE_LETTER = /^[A-Za-z]:/;
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/** The source half of `source:target[:ro]`. */
export function mountSource(mapping: string): string {
  const offset = DRIVE_PREFIX.test(mapping) ? 2 : 0;
  const separator = mapping.indexOf(":", offset);
  return separator === -1 ? mapping : mapping.slice(0, separator);
}

/**
 * Whether a mount source names a directory on the host rather than a volume
 * Docker manages.
 *
 * It decides two things that must never be got wrong: whether the panel creates
 * it, and whether the panel may delete it. A host path is the operator's on
 * both counts.
 */
export function isHostPath(source: string): boolean {
  return source.startsWith("/") || source.startsWith("\\") || DRIVE_LETTER.test(source);
}
