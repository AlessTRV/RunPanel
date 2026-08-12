import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { databaseNameSchema } from "@/lib/validation";
import { databaseAdmin, DatabaseBusyError, serviceTarget } from "@/services/service-databases";

type Params = { params: Promise<{ serviceId: string; name: string }> };

/**
 * Dropping a database is keyed by its name rather than by a row id, so a
 * database created out of band with `psql` can be dropped from here too — the
 * name is the identity the engine recognises.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId, name: rawName } = await params;

  // Validated before it can reach a `DROP DATABASE`, where an identifier cannot
  // be parameterised and this schema is the only thing standing in the way.
  const parsed = databaseNameSchema.safeParse(decodeURIComponent(rawName));
  if (!parsed.success) {
    return NextResponse.json({ error: "Nome non valido" }, { status: 400 });
  }
  const name = parsed.data;

  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) {
    return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });
  }

  const admin = databaseAdmin(service.type);
  if (!admin.supported) {
    return NextResponse.json(
      { error: "Questo tipo di servizio non ha database con un nome." },
      { status: 400 }
    );
  }

  if (admin.system.includes(name)) {
    return NextResponse.json(
      { error: `"${name}" appartiene al motore e non si può eliminare.` },
      { status: 400 }
    );
  }

  const target = serviceTarget(service);

  // The primary database is the one inside the service's own credentials and so
  // inside every URL the panel hands out, including the one it injects at
  // deploy. Dropping it would leave the service pointing at nothing.
  if (name === target.credentials.database) {
    return NextResponse.json(
      { error: "È il database principale del servizio: per eliminarlo elimina il servizio." },
      { status: 400 }
    );
  }

  if (service.status !== "running") {
    return NextResponse.json(
      { error: "Il servizio è fermo: avvialo per eliminare un database." },
      { status: 409 }
    );
  }

  try {
    await admin.drop(target, name);
  } catch (err: unknown) {
    if (err instanceof DatabaseBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Eliminazione non riuscita";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await db
    .deleteFrom("service_databases")
    .where("service_id", "=", serviceId)
    .where("name", "=", name)
    .execute();

  return NextResponse.json({ success: true });
}
