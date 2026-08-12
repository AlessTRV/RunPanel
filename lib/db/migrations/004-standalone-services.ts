import { Kysely } from "kysely";

/**
 * Services stop depending on a project to be identifiable.
 *
 * Two things were only ever implicit, and both break the moment a service can
 * exist outside a project.
 *
 * The container name was derived at every call site — `config.containerName` if
 * the JSON happened to have it, otherwise `runpanel-svc-<name>` with the project
 * slug silently dropped. That fallback produces exactly the name a service with
 * NO project owns, so a project's service with an empty `config` resolved to a
 * standalone service's container: control actions and deletes could hit the
 * wrong one. It becomes a column, so there is one answer and the database
 * enforces that two services can never claim the same container.
 *
 * And a service is a database *server*, not a database. One Postgres holds as
 * many as you make; `service_databases` is where the extra ones are recorded.
 */

/** The subset this migration reads and writes, typed so the backfill is checked. */
type MigrationDb = Kysely<{
  services: {
    id: string;
    name: string;
    config: string | null;
    project_id: string | null;
    container_name: string | null;
  };
  projects: { id: string; slug: string };
}>;

/** Kept local: this is the naming as of migration 004, not whatever it becomes. */
function derivedContainerName(name: string, projectSlug: string | null): string {
  return projectSlug ? `runpanel-svc-${projectSlug}-${name}` : `runpanel-svc-${name}`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Added nullable and backfilled rather than NOT NULL with a default: SQLite
  // cannot add a NOT NULL column to a table that already has rows, and a
  // placeholder default would be a value the code would have to distrust
  // forever. Every row is filled in below, and the app always writes it.
  await db.schema.alterTable("services").addColumn("container_name", "text").execute();

  const typed = db as unknown as MigrationDb;

  const [services, projects] = await Promise.all([
    typed.selectFrom("services").select(["id", "name", "config", "project_id"]).execute(),
    typed.selectFrom("projects").select(["id", "slug"]).execute(),
  ]);

  const slugById = new Map(projects.map((p) => [p.id, p.slug]));
  const taken = new Set<string>();

  for (const service of services) {
    let name = "";
    try {
      name = (JSON.parse(service.config || "{}") as { containerName?: string }).containerName ?? "";
    } catch {
      /* an unreadable config just means deriving the name instead */
    }
    if (!name) {
      name = derivedContainerName(service.name, slugById.get(service.project_id ?? "") ?? null);
    }

    // Two rows resolving to one container is the ambiguity this migration
    // exists to end, and it is real for anything created before it. The unique
    // index below would refuse to build, so the collision is broken here with
    // the row id — the loser points at a container that does not exist, which
    // is visible and fixable, unlike two services quietly sharing one.
    if (taken.has(name)) name = `${name}-${service.id}`;
    taken.add(name);

    await typed
      .updateTable("services")
      .set({ container_name: name })
      .where("id", "=", service.id)
      .execute();
  }

  await db.schema
    .createIndex("idx_services_container_name")
    .unique()
    .on("services")
    .column("container_name")
    .execute();

  // A service's own name only has to be unique where it is displayed together
  // with its siblings. Standalone services (project_id NULL) are not covered:
  // NULLs compare distinct in both dialects, and the container name index above
  // is what actually prevents them from colliding.
  await db.schema
    .createIndex("idx_services_project_name")
    .unique()
    .on("services")
    .columns(["project_id", "name"])
    .execute();

  await db.schema
    .createTable("service_databases")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("service_id", "text", (col) =>
      col.notNull().references("services.id").onDelete("cascade")
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_service_databases_unique")
    .unique()
    .on("service_databases")
    .columns(["service_id", "name"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("service_databases").ifExists().execute();
  await db.schema.dropIndex("idx_services_project_name").ifExists().execute();
  await db.schema.dropIndex("idx_services_container_name").ifExists().execute();
  await db.schema.alterTable("services").dropColumn("container_name").execute();
}
