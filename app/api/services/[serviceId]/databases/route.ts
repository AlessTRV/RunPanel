import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { createDatabaseSchema } from "@/lib/validation";
import { databaseAdmin, serviceTarget } from "@/services/service-databases";

type Params = { params: Promise<{ serviceId: string }> };

interface ServiceDatabase {
  name: string;
  /** The one in the service's own credentials, and so in its injected URL. */
  primary: boolean;
  /** The panel has a row for it. False means it was created out of band. */
  managed: boolean;
  /** The engine reports it. False means the row outlived the database. */
  present: boolean;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
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
    return NextResponse.json({ supported: false, running: false, databases: [] });
  }

  const rows = await db
    .selectFrom("service_databases")
    .select("name")
    .where("service_id", "=", serviceId)
    .orderBy("name")
    .execute();

  const target = serviceTarget(service);
  const primary = target.credentials.database;

  // The engine is the authority on what exists; the rows are what the panel
  // promised. Reported together rather than reconciled into one list, because
  // "created with psql and invisible here" and "recorded here but gone from the
  // engine" are different problems and only one of them is the panel's fault.
  let live: string[] = [];
  let running = false;
  if (service.status === "running") {
    try {
      live = (await admin.list(target)).filter((name) => !admin.system.includes(name));
      running = true;
    } catch {
      /* a container that cannot answer is reported as not running */
    }
  }

  const managed = new Set(rows.map((r) => r.name));
  const names = new Set([...(primary ? [primary] : []), ...managed, ...live]);

  const databases: ServiceDatabase[] = [...names].sort().map((name) => ({
    name,
    primary: name === primary,
    managed: managed.has(name),
    // With the container down nothing can be confirmed, so nothing is denied:
    // claiming every database is missing would be a scarier lie than silence.
    present: running ? live.includes(name) : true,
  }));

  return NextResponse.json({ supported: true, running, databases });
}

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = createDatabaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Nome non valido" },
      { status: 400 }
    );
  }

  const { name } = parsed.data;
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

  if (service.status !== "running") {
    return NextResponse.json(
      { error: "Il servizio è fermo: avvialo per creare un database." },
      { status: 409 }
    );
  }

  const target = serviceTarget(service);

  if (name === target.credentials.database || admin.system.includes(name)) {
    return NextResponse.json({ error: `"${name}" esiste già.` }, { status: 409 });
  }

  const existing = await db
    .selectFrom("service_databases")
    .select("id")
    .where("service_id", "=", serviceId)
    .where("name", "=", name)
    .executeTakeFirst();

  if (existing) {
    return NextResponse.json({ error: `"${name}" esiste già.` }, { status: 409 });
  }

  try {
    // The engine first: a row for a database that was never created is the
    // failure mode this ordering exists to avoid.
    await admin.create(target, name);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Creazione non riuscita";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await db
    .insertInto("service_databases")
    .values({ id: generateId(), service_id: serviceId, name, created_at: nowIso() })
    .execute();

  return NextResponse.json({ name }, { status: 201 });
}
