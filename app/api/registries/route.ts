import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import {
  DOCKER_HUB,
  listRegistries,
  registrySchema,
  removeRegistry,
  saveRegistry,
} from "@/services/docker/registry";

/** Registries the panel can authenticate to. Passwords are never returned. */
export async function GET() {
  const denied = await requirePermission("registries");
  if (isDenied(denied)) return denied;

  return NextResponse.json(
    { registries: await listRegistries(), dockerHub: DOCKER_HUB },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "registries.update", scope: "permission", scopeId: "registries" }, async () => {
    const denied = await requirePermission("registries");
    if (isDenied(denied)) return denied;

    const parsed = registrySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Credenziali non valide", details: parsed.error.issues },
        { status: 400 }
      );
    }

    await saveRegistry(parsed.data);
    return NextResponse.json({ success: true, registries: await listRegistries() });
  });
}

export async function DELETE(request: NextRequest) {
  return withAudit(request, { category: "system", action: "registries.delete", scope: "permission", scopeId: "registries" }, async () => {
    const denied = await requirePermission("registries");
    if (isDenied(denied)) return denied;

    const registry = request.nextUrl.searchParams.get("registry");
    if (!registry) {
      return NextResponse.json({ error: "Serve il parametro registry" }, { status: 400 });
    }

    await removeRegistry(registry);
    return NextResponse.json({ success: true, registries: await listRegistries() });
  });
}
