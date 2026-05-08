import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth";
import { removeService, serviceContainerName } from "@/services/service-provisioner";

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

  // Resolve container name from config or legacy unscoped fallback
  let containerName: string;
  try {
    const cfg = JSON.parse((service.config as string) || "{}");
    containerName = cfg.containerName;
  } catch { containerName = ""; }
  if (!containerName) {
    containerName = serviceContainerName(service.name as string);
  }

  try {
    await removeService(containerName);
  } catch { /* ignore */ }

  db.prepare("DELETE FROM services WHERE id = ?").run(serviceId);
  return NextResponse.json({ success: true });
}
