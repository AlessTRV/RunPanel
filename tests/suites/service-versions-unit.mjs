import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Which versions are offered, and where PostgreSQL puts its data.
 *
 * The second half is the one that matters. PostgreSQL 18 made `PGDATA`
 * version-specific and moved its declared `VOLUME` up a level, so a volume
 * mounted at the old path under 18 is a directory nothing writes to: the server
 * initialises inside an anonymous volume, everything works, and the database is
 * empty the first time the container is recreated. That is not a failure any
 * test would catch by watching a container start — it needs the mount point
 * asserted directly, which is why this is a function and not a literal.
 *
 * Standalone: `lib/service-versions.ts` has no imports precisely so this runs
 * with no server and no daemon.
 */
export const meta = { name: "service-versions-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("service-versions-unit");
  const { SERVICE_VERSIONS, versionsFor, defaultVersionFor, postgresVolumePath } = await import(
    pathToFileURL(join(repoRoot, "lib", "service-versions.ts")).href
  );

  const OLD = "/var/lib/postgresql/data";
  const NEW = "/var/lib/postgresql";

  // --- the 17/18 boundary ----------------------------------------------------
  {
    r.check("14 keeps the old data path", postgresVolumePath("14") === OLD, postgresVolumePath("14"));
    r.check("16 keeps it", postgresVolumePath("16") === OLD, postgresVolumePath("16"));
    r.check("17 is the last one that does", postgresVolumePath("17") === OLD, postgresVolumePath("17"));

    // Where the change lands. Getting this wrong is a database that works until
    // the container is recreated and is then empty.
    r.check("18 moves to the volume root", postgresVolumePath("18") === NEW, postgresVolumePath("18"));
    r.check("and so does everything after it", postgresVolumePath("21") === NEW, postgresVolumePath("21"));

    // The image publishes prerelease tags like `19beta3`; the layout is the new
    // one there too, and parseInt reads the major off the front.
    r.check("a prerelease tag reads its major", postgresVolumePath("19beta3") === NEW, postgresVolumePath("19beta3"));

    // An unparseable version takes the path every existing service is already
    // on. Guessing the new layout for a value we do not understand is how a
    // database gets lost.
    r.check("an unreadable version falls back to the old path", postgresVolumePath("latest") === OLD);
    r.check("as does an empty one", postgresVolumePath("") === OLD);
  }

  // --- the lists -------------------------------------------------------------
  {
    const engines = Object.keys(SERVICE_VERSIONS);
    r.check("all four engines are listed", engines.length === 4, engines.join(","));

    for (const engine of engines) {
      const { default: fallback, available } = SERVICE_VERSIONS[engine];

      r.check(`${engine} offers at least one version`, available.length > 0);
      r.check(`${engine} default is offered`, available.includes(fallback), `${fallback} ∉ ${available.join(",")}`);

      // The wizard preselects `available[0]` and renders the list in order, so
      // a default that is not the head shows one version and creates another.
      r.check(`${engine} default is the first offered`, available[0] === fallback, `${available[0]} vs ${fallback}`);

      r.check(`${engine} has no duplicates`, new Set(available).size === available.length);

      // Every entry becomes an image tag verbatim. A stray space or a `/` makes
      // an invalid reference, which surfaces as a pull failure at create time.
      r.check(
        `${engine} versions look like tags`,
        available.every((v) => /^[\w][\w.-]*$/.test(v)),
        available.join(",")
      );

      r.check(`${engine} accessors agree`, defaultVersionFor(engine) === fallback && versionsFor(engine) === available);
    }
  }

  // --- the two that are easy to get wrong ------------------------------------
  {
    // `mongo` publishes 8.3 and 8.0 but no bare `8`, so the obvious short form
    // would fail to pull. Pinned here because the mistake is invisible until a
    // service is created.
    r.check(
      "mongodb is minor-qualified, since there is no bare major tag",
      SERVICE_VERSIONS.mongodb.available.every((v) => v.includes(".")),
      SERVICE_VERSIONS.mongodb.available.join(",")
    );

    // Dropped from the wizard because upstream no longer lists them among
    // supported tags. Existing services on them are untouched — nothing
    // compares a stored version against this list.
    r.check("postgres 13 is no longer offered", !SERVICE_VERSIONS.postgresql.available.includes("13"));
    r.check("mysql 5.7 is no longer offered", !SERVICE_VERSIONS.mysql.available.includes("5.7"));
  }

  return r.result();
}
