import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { updateProjectSchema } from "@/lib/validation";
import { deployContractSchema, normalizeContractInput } from "@/lib/deploy-contract";
import { getPreset } from "@/services/deploy-presets";
import { processManager } from "@/services/process-manager";
import { removeService } from "@/services/service-provisioner";
import { removeProjectNetwork } from "@/services/docker-network";
import { removeProjectImages } from "@/services/docker/images";
import { removeProjectVolumes } from "@/services/docker/volumes";
import { removePm2Artifacts } from "@/services/process-drivers/pm2-driver";
import { forgetRun } from "@/services/process-drivers/run-log";
import { removeEnvFile } from "@/services/env-file";
import { clearQueuedDeploy } from "@/services/deploy-queue";
import { processLogHub } from "@/services/process-logs";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const stats = await db
    .selectFrom("deployments")
    .select((eb) => [eb.fn.count("id").as("deploy_count"), eb.fn.max("started_at").as("last_deploy_at")])
    .where("project_id", "=", projectId)
    .executeTakeFirst();

  return NextResponse.json({
    ...project,
    deploy_count: Number(stats?.deploy_count ?? 0),
    last_deploy_at: stats?.last_deploy_at ?? null,
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const { name, appName, sourceType, sourceUrl, sourceBranch, runtimeType, port, autoDeploy, builderConfig, presetId } =
    parsed.data;

  const updates: Partial<ProjectsTable> = {};
  if (name !== undefined) updates.name = name;
  if (appName !== undefined) updates.app_name = appName || null;
  if (sourceType !== undefined) updates.source_type = sourceType;
  if (sourceUrl !== undefined) updates.source_url = sourceUrl;
  if (sourceBranch !== undefined) updates.source_branch = sourceBranch;
  if (runtimeType !== undefined && runtimeType !== null) updates.runtime_type = runtimeType;
  if (port !== undefined) updates.port = port;
  if (autoDeploy !== undefined) updates.auto_deploy = autoDeploy ? 1 : 0;

  if (builderConfig !== undefined) {
    // Normalise first: callers may still send the pre-contract shape
    // (installCmd/buildCmd/startCmd/dockerImage). Validating before that would
    // discard those keys and leave the project with no commands.
    const normalized = normalizeContractInput(builderConfig);

    // A hand-picked preset sits UNDER what the caller sent, never over it: the
    // operator typing a start command has said something more specific than the
    // preset's default, and the preset must not take it back.
    const preset = presetId ? getPreset(presetId) : null;
    if (preset) {
      Object.assign(normalized, {
        ...preset.contract,
        ...normalized,
      });
    }

    // Validate for shape, but persist the NORMALISED INPUT rather than the
    // parsed result. Parsing fills in every default, and a stored config full
    // of defaults is indistinguishable from one the operator chose — which
    // would stop a repository's runpanel.json from ever contributing a value.
    const parsed = deployContractSchema.safeParse(normalized);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Configurazione di deploy non valida", details: parsed.error.issues },
        { status: 400 }
      );
    }
    updates.builder_config = JSON.stringify({ version: 1, ...normalized });
  }

  if (Object.keys(updates).length > 0) {
    updates.updated_at = nowIso();
    await db.updateTable("projects").set(updates).where("id", "=", projectId).execute();
  }

  const updated = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  return NextResponse.json(updated);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const { slug } = project;

  // Drop any follow-up deploy and stop following this project's logs before
  // taking anything apart, so nothing tries to redeploy what we are deleting.
  clearQueuedDeploy(projectId);
  processLogHub.detachAll(projectId);

  // Stop the running process (PM2 delete or Docker rm)
  try {
    // `remove`, not `stop`: a stopped container still references its image, so
    // stopping here would leave both the container and the image on disk.
    await processManager.remove(slug, project.runtime_type);
  } catch { /* ignore */ }

  // Remove every image RunPanel built for this project, not just the one tag
  // the old code knew about — each deploy produces its own immutable tag.
  await removeProjectImages(slug);

  // Stop and remove every service container linked to this project. The volumes
  // are not passed here: `removeProjectVolumes` below takes them all by label,
  // which is both scoped and complete.
  const services = await db
    .selectFrom("services")
    .select("container_name")
    .where("project_id", "=", projectId)
    .execute();

  for (const svc of services) {
    try {
      await removeService(svc.container_name);
    } catch { /* ignore */ }
  }

  // Deleting the project deletes its databases' storage too. Previously the
  // containers went and the named volumes stayed on disk forever, invisible and
  // ready to silently reattach to a future service with the same name.
  const volumesRemoved = await removeProjectVolumes(slug);

  // Delete project source.
  //
  // Asynchronously, because this tree contains `node_modules`: the synchronous
  // version walked a hundred thousand files with the event loop stopped, so
  // deleting one project froze the whole panel — every other tab, every poll,
  // every running deploy's log stream — for as long as it took.
  const repoDir = path.join(config.reposDir, slug);
  await fs.promises.rm(repoDir, { recursive: true, force: true });

  // Delete generated PM2 files, including the 0600 sidecar holding the
  // project's environment and the process logs, plus the marker saying when the
  // last run began.
  removePm2Artifacts(slug);
  forgetRun(slug);
  removeEnvFile(slug);

  try {
    await removeProjectNetwork(slug);
  } catch { /* ignore */ }

  // Child rows go with the parent: the schema declares ON DELETE CASCADE on
  // deployments, env_vars, services and webhook_deliveries, so a single delete
  // is enough — no hand-rolled ordering to get wrong.
  await db.deleteFrom("projects").where("id", "=", projectId).execute();

  return NextResponse.json({ success: true, volumesRemoved });
}
