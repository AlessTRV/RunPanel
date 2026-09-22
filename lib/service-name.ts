/**
 * A service's two names.
 *
 * `name` is the technical one, and like a project's slug it never changes: it
 * is part of the service's volume names (`runpanel-postgres-<slug>-<name>`),
 * of its ownership label, and of what the garbage collector and the delete
 * dialog derive to find its data. Docker cannot rename a volume, so a `name`
 * that changed would point every one of those at a volume that does not
 * exist — or worse, create it empty and start the database on it.
 *
 * `display_name` is what the panel shows, and it changes whenever the operator
 * likes. The container follows it, but only at a moment the operator chose for
 * a restart anyway: the next deploy of the project the service belongs to. The
 * volume never follows it.
 *
 * No imports, so the unit suite loads it directly.
 */

export const MAX_DISPLAY_NAME = 60;

/** The rule `serviceNameSchema` enforces on a technical name. */
const TECHNICAL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_TECHNICAL_NAME = 38;

export function serviceDisplayName(service: { name: string; display_name?: string | null }): string {
  const shown = service.display_name?.trim();
  return shown ? shown : service.name;
}

/**
 * The technical form of a displayed name — what the container is called
 * after it follows a rename. "Database principale" becomes
 * `database-principale`, "Città" becomes `citta`. Null when nothing usable is
 * left, in which case the container keeps the name it has.
 */
export function technicalServiceName(displayName: string): string | null {
  const name = displayName
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, MAX_TECHNICAL_NAME)
    .replace(/[-_]+$/, "");
  return TECHNICAL_NAME.test(name) ? name : null;
}

export type ContainerRenamePlan =
  | { action: "keep" }
  | { action: "rename"; from: string; to: string }
  | { action: "blocked"; to: string; reason: string };

/**
 * Whether a service's container should take a new name, decided from data.
 *
 * `desired` is the container name its displayed name maps to, or null when
 * it maps to none. `taken` holds every name another container — or another
 * service's network alias — already answers to: two containers answering to
 * one name on the same network is a coin toss for every client that asks.
 */
export function planContainerRename(input: {
  containerName: string;
  desired: string | null;
  taken: ReadonlySet<string>;
}): ContainerRenamePlan {
  const { containerName, desired, taken } = input;
  if (!desired || desired === containerName) return { action: "keep" };
  if (taken.has(desired)) {
    return { action: "blocked", to: desired, reason: `il nome ${desired} è già usato da un altro container` };
  }
  return { action: "rename", from: containerName, to: desired };
}

/**
 * The aliases a renamed container keeps answering to: the name it had, and
 * whatever it already answered to, without its own new name among them.
 */
export function aliasesAfterRename(previous: readonly string[], from: string, to: string): string[] {
  return [...new Set([...previous, from])].filter((alias) => alias !== to);
}

export function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((alias): alias is string => typeof alias === "string") : [];
  } catch {
    return [];
  }
}
