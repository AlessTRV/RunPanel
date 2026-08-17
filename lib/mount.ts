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

/**
 * One bind: a folder on the host appearing at a path inside a container.
 *
 * Declared here, in the module with no imports, because the schema that
 * validates it, the templates that are handed it and the service that applies
 * it would otherwise import each other in a circle.
 */
export interface ServiceMount {
  /** Stable across edits, so a re-ordered list does not read as a new one. */
  id: string;
  /** The directory on the host. */
  source: string;
  /** Where it appears inside the container. */
  target: string;
  enabled: boolean;
  readOnly: boolean;
}

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

/**
 * Read a `source:target[:ro]` mapping into its parts, or null if it is not one.
 *
 * The string form is what a repository's `runpanel.json` has always written, and
 * what `docker run -v` takes. The object form is what an editor needs, because
 * an on/off switch has nowhere to live in a string. Both spellings exist on
 * purpose; this is the one place that converts between them, so they cannot come
 * to disagree about where a mapping splits.
 */
export function parseMountString(raw: string): { source: string; target: string; readOnly: boolean } | null {
  const source = mountSource(raw);
  if (!source || source === raw) return null;

  let rest = raw.slice(source.length + 1);
  if (!rest) return null;

  let readOnly = false;
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const mode = rest.slice(lastColon + 1);
    if (mode === "ro" || mode === "rw") {
      readOnly = mode === "ro";
      rest = rest.slice(0, lastColon);
    }
  }

  return rest ? { source, target: rest, readOnly } : null;
}

/** The inverse. The only place a `-v` argument is spelled. */
export function formatMountString(spec: { source: string; target: string; readOnly?: boolean }): string {
  return spec.readOnly ? `${spec.source}:${spec.target}:ro` : `${spec.source}:${spec.target}`;
}
