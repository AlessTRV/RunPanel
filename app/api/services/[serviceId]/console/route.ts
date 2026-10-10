import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireService } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { SERVICE_ACTIONS, satisfies } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { serviceConsoleSchema } from "@/lib/validation";
import { isDockerAvailable } from "@/services/docker/cli";
import { closeConsole, openConsole, writeConsole } from "@/services/service-console";

type Params = { params: Promise<{ serviceId: string }> };

/**
 * Open a session on a service, type into it, close it.
 *
 * Output does not come back through here — it goes onto the service's event
 * channel and reaches the browser over `../stream`. This route only carries the
 * three things a session does that a stream cannot express.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { serviceId } = await params;
  // Following the logs needs only read access; a shell or a database client
  // needs the console. Which one is asked for is in the body, checked below.
  const denied = await requireService(serviceId, "view");
  if (isDenied(denied)) return denied;
  const userId = denied.session.user.id;

  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = serviceConsoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) {
    return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });
  }

  const action = parsed.data;
  const needsConsole = action.action === "input" || (action.action !== "stop" && action.mode !== "logs");
  if (needsConsole && !satisfies(denied.access, SERVICE_ACTIONS.console)) {
    return NextResponse.json({ error: "Non hai il permesso per questa operazione" }, { status: 403 });
  }

  if (action.action === "stop") {
    closeConsole(serviceId, userId);
    return NextResponse.json({ status: "stopped" });
  }

  if (action.action === "input") {
    // Not an error: the reaper legitimately gets there first on an idle
    // session, and a browser that types into one should be told to reopen
    // rather than shown a failure it did not cause.
    return NextResponse.json({ status: writeConsole(serviceId, userId, action.input) ? "ok" : "closed" });
  }

  if (!(await isDockerAvailable())) {
    return NextResponse.json({ error: "Docker non è raggiungibile" }, { status: 503 });
  }

  // A stopped container has nothing to exec into, and the session would open
  // and die in the same instant with an error from Docker rather than from
  // here. `logs` is exempt: the log of a container that is not running is
  // exactly what someone stares at to find out why.
  if (action.mode !== "logs" && service.status !== "running") {
    return NextResponse.json(
      { error: "Il servizio è fermo: avvialo per aprire una sessione." },
      { status: 409 }
    );
  }

  try {
    const { mode } = await openConsole(service, action.mode, userId);
    if (mode !== "logs") {
      await audit({ userId, category: "terminal", action: `service.console.${mode}`, scope: "service", scopeId: serviceId, request });
    }
    return NextResponse.json({ status: "started", mode, container: service.container_name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Apertura non riuscita";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
