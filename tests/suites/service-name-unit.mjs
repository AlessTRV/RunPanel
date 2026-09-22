import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * A service's two names, and the volume that must not follow either.
 *
 * The operator asked to rename existing services. What makes that dangerous is
 * that the technical name is part of the volume name: re-derived after a
 * change, it points a recreated database at a fresh, empty volume while its
 * data sits in the old one. So the rules here are the whole feature: what is
 * shown, what the container becomes, when a rename is refused, and that a
 * recreate always goes back onto the volume it came from.
 *
 * Standalone: pure modules, no server and no daemon.
 */
export const meta = { name: "service-name-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("service-name-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  const names = await load("lib", "service-name.ts");
  const { keepVolumeSources } = await load("lib", "mount.ts");
  const { serviceContainerName } = await load("services", "docker", "labels.ts");

  // --- what is shown -----------------------------------------------------------
  r.check("no display name shows the technical one", names.serviceDisplayName({ name: "db", display_name: null }) === "db");
  r.check("a blank one does too", names.serviceDisplayName({ name: "db", display_name: "   " }) === "db");
  r.check(
    "a display name is shown as typed",
    names.serviceDisplayName({ name: "db", display_name: "Database principale" }) === "Database principale"
  );

  // --- what the container becomes ------------------------------------------------
  for (const [shown, technical] of [
    ["Database principale", "database-principale"],
    ["Città", "citta"],
    ["  Cache / Sessioni  ", "cache-sessioni"],
    ["db_2", "db_2"],
    ["--leading", "leading"],
    ["x".repeat(60), "x".repeat(38)],
  ]) {
    r.check(
      `"${shown.trim().slice(0, 20)}" becomes ${technical}`,
      names.technicalServiceName(shown) === technical,
      String(names.technicalServiceName(shown))
    );
  }
  r.check("a name with nothing usable gives none", names.technicalServiceName("🎉 !!!") === null);
  r.check(
    "and never a name the service schema would refuse",
    ["Database principale", "Città", "a-b_c", "9lives"].every((shown) =>
      /^[a-z0-9][a-z0-9_-]*$/.test(names.technicalServiceName(shown) ?? "")
    )
  );

  // --- when it is renamed ------------------------------------------------------------
  const desired = serviceContainerName("database-principale", "shop");
  r.check("the container name keeps the project scope", desired === "runpanel-svc-shop-database-principale", desired);

  {
    const plan = names.planContainerRename({ containerName: "runpanel-svc-shop-db", desired, taken: new Set() });
    r.check(
      "a new name renames the container",
      plan.action === "rename" && plan.from === "runpanel-svc-shop-db" && plan.to === desired,
      JSON.stringify(plan)
    );
  }
  r.check(
    "the same name is left alone",
    names.planContainerRename({ containerName: desired, desired, taken: new Set() }).action === "keep"
  );
  r.check(
    "no usable name is left alone",
    names.planContainerRename({ containerName: "runpanel-svc-shop-db", desired: null, taken: new Set() }).action === "keep"
  );
  {
    const plan = names.planContainerRename({
      containerName: "runpanel-svc-shop-db",
      desired,
      taken: new Set([desired]),
    });
    r.check("a name another container answers to is refused", plan.action === "blocked", JSON.stringify(plan));
    r.check("saying which", String(plan.reason).includes(desired));
  }

  // --- the old name keeps answering --------------------------------------------------
  r.check(
    "the previous name becomes an alias",
    JSON.stringify(names.aliasesAfterRename([], "runpanel-svc-shop-db", desired)) === '["runpanel-svc-shop-db"]'
  );
  r.check(
    "aliases accumulate across renames",
    JSON.stringify(names.aliasesAfterRename(["a"], "b", "c")) === '["a","b"]'
  );
  r.check(
    "renaming back drops the name it takes again from the aliases",
    JSON.stringify(names.aliasesAfterRename(["runpanel-svc-shop-db"], desired, "runpanel-svc-shop-db")) ===
      JSON.stringify([desired])
  );
  r.check("unreadable aliases are none", names.parseAliases("{nope").length === 0 && names.parseAliases(null).length === 0);

  // --- the data stays where it is ------------------------------------------------------
  {
    const derived = [{ source: "runpanel-postgres-newslug-db", target: "/var/lib/postgresql/data" }];
    const kept = keepVolumeSources(derived, { "/var/lib/postgresql/data": "runpanel-postgres-oldslug-db" });
    r.check(
      "a recreate goes back onto the volume the container had",
      kept[0].source === "runpanel-postgres-oldslug-db",
      JSON.stringify(kept)
    );
  }
  {
    const bind = [{ source: "/mnt/data/pg", target: "/var/lib/postgresql/data" }];
    const kept = keepVolumeSources(bind, { "/var/lib/postgresql/data": "runpanel-postgres-shop-db" });
    r.check("a bind the operator configured is left as given", kept[0].source === "/mnt/data/pg");
  }
  {
    const derived = [{ source: "runpanel-redis-shop-cache", target: "/data" }];
    const kept = keepVolumeSources(derived, { "/data": "/srv/redis" });
    r.check("a bind found on the old container never replaces a volume", kept[0].source === "runpanel-redis-shop-cache");
  }
  {
    const derived = [{ source: "runpanel-mysql-shop-db", target: "/var/lib/mysql/" }];
    const kept = keepVolumeSources(derived, { "/var/lib/mysql": "runpanel-mysql-old-db" });
    r.check("paths match with or without a trailing slash", kept[0].source === "runpanel-mysql-old-db");
  }
  r.check(
    "with nothing asked, the derivation stands",
    keepVolumeSources([{ source: "v", target: "/d" }], undefined)[0].source === "v"
  );

  return r.result();
}
