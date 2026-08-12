import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { resolveAutostart } from "@/lib/autostart";
import { getDb } from "@/lib/db";
import { autostartFixSchema } from "@/lib/validation";
import { applyFix } from "@/services/autostart/install";
import { setRestartPolicy } from "@/services/autostart/probe";

/**
 * The one-click repairs the page offers.
 *
 * `restart-policy` is deliberately an explicit action and not something the
 * reconciler does on its own: changing a running production container's restart
 * policy behind the operator's back, at boot, is not a decision a background
 * job gets to make.
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

  const parsed = autostartFixSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { fix, target } = parsed.data;

  if (fix !== "restart-policy") {
    const result = await applyFix(fix);
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }

  if (!target) {
    return NextResponse.json({ error: "Manca l'elemento da correggere" }, { status: 400 });
  }

  const db = await getDb();

  try {
    if (target.kind === "service") {
      const service = await db
        .selectFrom("services")
        .selectAll()
        .where("id", "=", target.id)
        .executeTakeFirst();
      if (!service) return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });

      const wanted = resolveAutostart("service", service).autostart ? "unless-stopped" : "no";
      await setRestartPolicy(service.container_name, wanted);
      return NextResponse.json({ ok: true, message: `Restart policy allineata a "${wanted}"` });
    }

    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", target.id)
      .executeTakeFirst();
    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

    if (project.runtime_type === "compose") {
      return NextResponse.json(
        {
          error:
            "La restart policy di uno stack compose sta nel suo yaml: modificala lì, non dal pannello.",
        },
        { status: 400 }
      );
    }

    const wanted = resolveAutostart("project", project).autostart ? "unless-stopped" : "no";
    await setRestartPolicy(`runpanel-${project.slug}`, wanted);
    return NextResponse.json({ ok: true, message: `Restart policy allineata a "${wanted}"` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Correzione non riuscita";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
