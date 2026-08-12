import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { controlActionSchema } from "@/lib/validation";
import { startService, stopService, restartService } from "@/services/service-provisioner";

type Params = { params: Promise<{ serviceId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const body = await request.json();
  const parsed = controlActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
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

  const { action } = parsed.data;
  const containerName = service.container_name;

  const setStatus = (status: "running" | "stopped") =>
    db
      .updateTable("services")
      .set({ status, updated_at: nowIso() })
      .where("id", "=", serviceId)
      .execute();

  try {
    switch (action) {
      case "start":
        await startService(containerName);
        await setStatus("running");
        break;
      case "stop":
        await stopService(containerName);
        await setStatus("stopped");
        break;
      case "restart":
        await restartService(containerName);
        await setStatus("running");
        break;
    }

    return NextResponse.json({ success: true, action });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `${action} failed`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
