/**
 * Which versions of each database engine the panel offers, and the one thing
 * that changes between them.
 *
 * There used to be two lists. `availableVersions` on each service template said
 * one thing, `DATABASE_OPTIONS` in the wizard's catalogue said another, and they
 * had drifted — PostgreSQL 13 was offered by the template and not by the form —
 * because nothing in the repository ever read the template's copy. A list that
 * is never read cannot be wrong in a way anyone notices, which is exactly how it
 * ends up wrong. So there is one list now, and both sides import it.
 *
 * Zero imports, deliberately, and for three reasons at once: the wizard's
 * catalogue is bundled for the browser, the templates run on the server, and the
 * standalone test suite loads this file directly by URL — where Node resolves
 * neither the `@/` alias nor an extensionless relative specifier.
 *
 * **What goes in the list.** Every major the official image currently supports,
 * minus the preview and short-cadence channels: PostgreSQL 19 is still beta,
 * MySQL 26 is an Innovation release supported for about a quarter, and MongoDB
 * 8.3 is a rapid release maintained only until the next one. None of those is a
 * thing to put a database on. `default` is the newest stable major and is always
 * `available[0]`.
 */

export type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";

export interface ServiceVersions {
  /** Offered first, and preselected. Always `available[0]`. */
  readonly default: string;
  /** Newest first — the wizard renders them in this order. */
  readonly available: readonly string[];
}

export const SERVICE_VERSIONS: Record<ServiceType, ServiceVersions> = {
  /** 13 is gone: the official image stopped listing it among supported tags. */
  postgresql: { default: "18", available: ["18", "17", "16", "15", "14"] },
  /** `9` is 9.7 LTS and `8` is 8.4 LTS. 5.7 went out of support in 2023. */
  mysql: { default: "9", available: ["9", "8"] },
  redis: { default: "8", available: ["8", "7", "6"] },
  /**
   * Minor-qualified on purpose: `mongo` publishes `8.3` and `8.0` but **no bare
   * `8`**, so the obvious `mongo:8` fails to pull. `7` and `7.0` are the same
   * image, so a service already on `7` is unaffected.
   */
  mongodb: { default: "8.0", available: ["8.0", "7.0"] },
};

/** The versions offered for one engine, newest first. */
export function versionsFor(type: ServiceType): readonly string[] {
  return SERVICE_VERSIONS[type].available;
}

/** The version a new service of this engine gets unless one is chosen. */
export function defaultVersionFor(type: ServiceType): string {
  return SERVICE_VERSIONS[type].default;
}

/**
 * Where PostgreSQL keeps its data, which as of 18 is not where it used to be.
 *
 * The official image made `PGDATA` version-specific in 18 — `/var/lib/postgresql/18/docker`,
 * with the number tracking the major — and moved its declared `VOLUME` from
 * `/var/lib/postgresql/data` up to `/var/lib/postgresql`.
 *
 * That turns the old mount into a trap rather than an error. A volume mounted at
 * `/var/lib/postgresql/data` under 18 is a directory nothing writes to: the
 * server initialises happily one level up, inside an anonymous volume, and the
 * database works perfectly right until the container is recreated — at which
 * point it comes back empty. Recreating a container is not rare here; it is what
 * changing the access restriction does.
 *
 * So the mount follows the major, which is what the image's own documentation
 * says to do. Mounting exactly at the declared `VOLUME` also avoids the stray
 * anonymous volume that a sub-path mount would leave behind on every run.
 */
export function postgresVolumePath(version: string): string {
  const major = Number.parseInt(version, 10);
  // An unparseable version takes the pre-18 path: it is where every existing
  // service already is, and guessing the new layout for a value we do not
  // understand is how you lose a database.
  return Number.isFinite(major) && major >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
}
