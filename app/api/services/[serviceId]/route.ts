import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth";
import { removeService } from "@/services/service-provisioner";

type Params = { params: Promise<{ serviceId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true";

  const db = getDb();
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId) as Record<string, unknown> | undefined;

  if (!service) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  if (reveal && service.credentials) {
    service.credentials = decrypt(service.credentials as string);
  } else {
    service.credentials = "hidden";
  }

  return NextResponse.json(service);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const db = getDb();
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId) as Record<string, unknown> | undefined;

  if (!service) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  try {
    await removeService(service.name as string);
  } catch { /* ignore */ }

  db.prepare("DELETE FROM services WHERE id = ?").run(serviceId);
  return NextResponse.json({ success: true });
}
