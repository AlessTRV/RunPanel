import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { autostartInstallSchema } from "@/lib/validation";
import { install, planInstall, uninstall } from "@/services/autostart/install";

/**
 * Install, remove, or just show what would be written.
 *
 * A non-root panel answers 200 with the commands rather than an error: not
 * being root is the ordinary case, not a failure, and the useful response is
 * the block of text the operator pastes into a terminal.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = autostartInstallSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { action, method } = parsed.data;

  if (action === "preview") {
    return NextResponse.json({ installed: false, plan: await planInstall(method) });
  }

  if (action === "uninstall") {
    const result = await uninstall();
    return NextResponse.json(result);
  }

  const result = await install(method);
  return NextResponse.json({ installed: result.ok, ...result });
}
