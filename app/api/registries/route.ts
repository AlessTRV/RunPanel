import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import {
  DOCKER_HUB,
  listRegistries,
  registrySchema,
  removeRegistry,
  saveRegistry,
} from "@/services/docker/registry";

/** Registries the panel can authenticate to. Passwords are never returned. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return NextResponse.json(
    { registries: await listRegistries(), dockerHub: DOCKER_HUB },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = registrySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Credenziali non valide", details: parsed.error.issues },
      { status: 400 }
    );
  }

  await saveRegistry(parsed.data);
  return NextResponse.json({ success: true, registries: await listRegistries() });
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const registry = request.nextUrl.searchParams.get("registry");
  if (!registry) {
    return NextResponse.json({ error: "Serve il parametro registry" }, { status: 400 });
  }

  await removeRegistry(registry);
  return NextResponse.json({ success: true, registries: await listRegistries() });
}
