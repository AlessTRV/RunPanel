import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
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
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const db = getDb();
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId) as Record<string, unknown> | undefined;
  if (!service) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const { action } = parsed.data;
  const name = service.name as string;

  try {
    switch (action) {
      case "start":
        await startService(name);
        db.prepare("UPDATE services SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(serviceId);
        break;
      case "stop":
        await stopService(name);
        db.prepare("UPDATE services SET status = 'stopped', updated_at = datetime('now') WHERE id = ?").run(serviceId);
        break;
      case "restart":
        await restartService(name);
        db.prepare("UPDATE services SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(serviceId);
        break;
    }

    return NextResponse.json({ success: true, action });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `${action} failed`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
