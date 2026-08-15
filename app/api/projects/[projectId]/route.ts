import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { updateProjectSchema } from "@/lib/validation";
import { deployContractSchema, normalizeContractInput, parseContractJson } from "@/lib/deploy-contract";
import { readAccess, reportGate, syncGate } from "@/services/access";
import { allocateLoopbackPort, closeGate } from "@/services/access-gate";
import { restartFromLastDeployment } from "@/services/project-restart";
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
    // The row says what was asked for; the gate says what is actually holding
    // the port. They differ whenever the panel restarted and could not bind.
    access: readAccess(project),
    gate: reportGate("project", projectId),
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
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const { name, appName, sourceType, sourceUrl, sourceBranch, runtimeType, port, autoDeploy, builderConfig, presetId, access } =
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

  // --- who may reach the app -------------------------------------------------
  const currentAccess = readAccess(project);
  let restartNeeded = false;

  if (access) {
    const wantsRestriction = access.mode === "restricted";
    const runtime = runtimeType ?? project.runtime_type;

    // Two shapes the panel cannot honestly restrict, refused up front rather
    // than accepted and quietly not enforced.
    if (wantsRestriction && runtime === "compose") {
      return NextResponse.json(
        {
          error:
            "Le porte di un progetto Compose le pubblica il tuo compose file. RunPanel non lo riscrive: metti il binding su 127.0.0.1 lì.",
        },
        { status: 409 }
      );
    }

    if (wantsRestriction && parseContractJson(project.builder_config).docker.network === "host") {
      return NextResponse.json(
        {
          error:
            "Con network: host il container condivide la rete dell'host e non c'è una porta da spostare. Passa a bridge o project per limitare l'accesso.",
        },
        { status: 409 }
      );
    }

    if (wantsRestriction && !(port ?? project.port)) {
      return NextResponse.json(
        { error: "Senza una porta configurata non c'è niente da limitare." },
        { status: 409 }
      );
    }

    updates.access_mode = access.mode;
    updates.access_allow = JSON.stringify(access.allow);
    // Allocated once and kept for as long as the target stays restricted, so
    // editing the list does not move the app.
    updates.access_port = wantsRestriction
      ? (project.access_port ?? (await allocateLoopbackPort()))
      : null;

    restartNeeded =
      updates.access_mode !== currentAccess.mode || updates.access_port !== currentAccess.port;
  }

  if (Object.keys(updates).length > 0) {
    updates.updated_at = nowIso();
    await db.updateTable("projects").set(updates).where("id", "=", projectId).execute();
  }

  let restartError: string | null = null;

  if (restartNeeded && project.status === "running") {
    // The listener has to move, and only a restart moves it. Done after the
    // columns are written so the restart reads the state it is meant to apply.
    const result = await restartFromLastDeployment(projectId);
    if ("error" in result) restartError = result.error;
  } else if (restartNeeded) {
    // Nothing is running, so nothing has to move: the binding applies at the
    // next start, which reads these columns. The gate still goes up, for the
    // same reason the boot reconciliation puts it up — a container with a
    // restart policy can come back without the panel starting it, and it comes
    // back on the loopback port. It also keeps the page from saying "gate non
    // attivo" about a restriction that is in force.
    const row = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (row) {
      await syncGate("project", projectId, row, { publicPort: row.port, label: row.name }).catch(
        (err: Error) => {
          restartError = err.message;
        }
      );
    }
  }

  const updated = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  return NextResponse.json({
    ...updated,
    access: updated ? readAccess(updated) : currentAccess,
    gate: reportGate("project", projectId),
    // Saved either way — the columns describe what was asked for — but the app
    // is still on its old port until it comes back, and that has to be said.
    accessWarning: restartError,
  });
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

  // A gate left open would keep holding the public port for a project that no
  // longer exists, and the next thing to claim it would fail to bind for no
  // visible reason.
  await closeGate("project", projectId);

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
