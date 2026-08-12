import { NextRequest, NextResponse } from "next/server";
import { autostartColumns, resolveAutostart } from "@/lib/autostart";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { autostartUpdateSchema } from "@/lib/validation";
import { autostartProbeCache, containerPolicies } from "@/services/autostart/probe";
import { storedConfig } from "@/services/autostart/install";
import { lastReport, reconcilerEnabled } from "@/services/autostart/reconcile";

/**
 * The whole autostart picture in one call: what the host does about booting the
 * panel, what the panel is supposed to bring back, and whether the containers
 * actually agree with that.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = await getDb();
  const [probe, policies, report, stored, services, projects] = await Promise.all([
    autostartProbeCache.get(),
    containerPolicies(),
    lastReport(),
    storedConfig(),
    db.selectFrom("services").selectAll().orderBy("name", "asc").execute(),
    db.selectFrom("projects").selectAll().orderBy("name", "asc").execute(),
  ]);

  const byContainer = new Map(policies.map((policy) => [policy.container, policy.actual]));

  const entries = [
    ...services.map((service) => {
      const settings = resolveAutostart("service", service);
      const actual = byContainer.get(service.container_name) ?? null;
      return {
        kind: "service" as const,
        id: service.id,
        name: service.name,
        subtitle: `${service.type} ${service.version}`,
        status: service.status,
        ...settings,
        restartPolicy: actual,
        // Docker will bring back anything with `unless-stopped` whatever the
        // panel thinks, so a mismatch means the switch in the UI is lying.
        policyMatches: actual === null ? null : matches(settings.autostart, actual),
        container: service.container_name,
      };
    }),
    ...projects.map((project) => {
      const settings = resolveAutostart("project", project);
      const container = `runpanel-${project.slug}`;
      const actual = byContainer.get(container) ?? null;
      const compose = project.runtime_type === "compose";
      return {
        kind: "project" as const,
        id: project.id,
        name: project.name,
        subtitle: `${project.slug} · ${project.runtime_type}`,
        status: project.status,
        ...settings,
        restartPolicy: actual,
        // A compose stack's policy lives in its own yaml, which is not ours to
        // rewrite, so it is reported and never flagged as wrong.
        policyMatches: compose || actual === null ? null : matches(settings.autostart, actual),
        container,
      };
    }),
  ];

  return NextResponse.json({
    probe,
    stored,
    report,
    entries,
    reconcilerEnabled: reconcilerEnabled(),
  });
}

function matches(autostart: boolean, actual: string): boolean {
  return autostart ? actual !== "no" && actual !== "" : actual === "no" || actual === "";
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = autostartUpdateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();

  for (const entry of parsed.data.entries) {
    const columns = autostartColumns({
      autostart: entry.autostart,
      order: entry.order,
      delaySeconds: entry.delaySeconds,
      waitHealthy: entry.waitHealthy,
    });

    if (entry.kind === "service") {
      await db
        .updateTable("services")
        .set({ ...columns, updated_at: nowIso() })
        .where("id", "=", entry.id)
        .execute();
    } else {
      await db
        .updateTable("projects")
        .set({ ...columns, updated_at: nowIso() })
        .where("id", "=", entry.id)
        .execute();
    }
  }

  return NextResponse.json({ ok: true, updated: parsed.data.entries.length });
}
