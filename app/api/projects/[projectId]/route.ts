import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { updateProjectSchema } from "@/lib/validation";
import { parseRepoSlug } from "@/lib/github";
import { deployContractSchema, normalizeContractInput, parseContractJson } from "@/lib/deploy-contract";
import {
  parseApplyJournal as parseProjectApply,
  projectMounts,
} from "@/services/project-mounts";
import { parseRepoMove, repoLocation } from "@/services/project-repo";
import { readAccess, reportGate, syncGate } from "@/services/access";
import { allocateLoopbackPort, closeGate } from "@/services/access-gate";
import { restartFromLastDeployment } from "@/services/project-restart";
import { getPreset } from "@/services/deploy-presets";
import { queuedForProject } from "@/services/one-time-commands";
import { folderExists } from "@/services/folders";
import { processManager } from "@/services/process-manager";
import { removeService } from "@/services/service-provisioner";
import { disconnectFromNetwork, removeProjectNetwork } from "@/services/docker-network";
import { removeProjectImages } from "@/services/docker/images";
import { containerMounts, listOwnedVolumes, removeProjectVolumes, removeVolumes } from "@/services/docker/volumes";
import { removePm2Artifacts } from "@/services/process-drivers/pm2-driver";
import { forgetRun } from "@/services/process-drivers/run-log";
import { removeEnvFile } from "@/services/env-file";
import { clearQueuedDeploy } from "@/services/deploy-queue";
import { syncAutoDeploy } from "@/services/webhook-manage";
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
    // `owner/name`, worked out here because `parseRepoSlug` sits next to
    // `getSetting` and cannot travel to a client component. Null for an
    // uploaded ZIP or a URL on some other host, which is what the version
    // picker keys off to know there is no commit history to browse.
    repo: parseRepoSlug(project.source_url)?.full ?? null,
    // The bind list as rows, so the editor never has to split a `-v` string —
    // there is one place that knows how a mapping splits, and it is not the
    // browser.
    mounts: projectMounts(parseContractJson(project.builder_config)),
    mountApply: parseProjectApply(project.mount_apply),
    // Where the checkout really is, asked of the filesystem rather than read off
    // the column: they differ exactly when something went wrong.
    repo_location: repoLocation(project.slug),
    repoMove: parseRepoMove(project.repo_move),
    // The queue only. It is small, and the header needs it on every poll to
    // say that the next deploy will not be an ordinary one. The history is
    // fetched by the section that shows it, so a project with two years of
    // chores does not widen a payload re-read on every deploy status change.
    oneTimeCommands: await queuedForProject(projectId, project.runtime_type),
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

  const { name, appName, sourceType, sourceUrl, sourceBranch, runtimeType, port, autoDeploy, deployTrigger, builderConfig, presetId, access, folderId } =
    parsed.data;

  // Checked before anything is written, so a move to a folder that is not
  // there changes nothing else in the same request either.
  if (folderId !== undefined && !(await folderExists(db, folderId))) {
    return NextResponse.json({ error: "Cartella non trovata" }, { status: 404 });
  }

  const updates: Partial<ProjectsTable> = {};
  if (name !== undefined) updates.name = name;
  if (folderId !== undefined) updates.folder_id = folderId;
  if (appName !== undefined) updates.app_name = appName || null;
  if (sourceType !== undefined) updates.source_type = sourceType;
  if (sourceUrl !== undefined) updates.source_url = sourceUrl;
  if (sourceBranch !== undefined) {
    updates.source_branch = sourceBranch;
    /*
      A different branch is a different timeline, and two columns describe the
      old one.

      `poll_sha` is the commit the poller last saw on the branch it was
      watching. Left in place, the first tick after the switch compares the new
      branch's head against a SHA that came from somewhere else, finds them
      different, and deploys on the spot — and the guard written for exactly
      this ("the first look records and does not deploy") never fires, because
      it tests `poll_sha === null`. Same column, same reason and same care as
      the `deployTrigger` guard below.

      A pin is a commit *of a branch*, so it cannot survive one either: held
      against a branch it does not belong to, every deploy would try to fetch it
      from a history that may not reach it.
    */
    if (sourceBranch !== project.source_branch) {
      updates.poll_sha = null;
      updates.pinned_sha = null;
      updates.pinned_at = null;
    }
  }
  if (runtimeType !== undefined && runtimeType !== null) updates.runtime_type = runtimeType;
  if (port !== undefined) updates.port = port;
  if (autoDeploy !== undefined) updates.auto_deploy = autoDeploy ? 1 : 0;

  if (deployTrigger !== undefined) {
    updates.deploy_trigger = deployTrigger;
    /*
      Switching away from polling forgets the commit it had seen.

      Otherwise a project polled last month, moved to webhooks and moved back
      would compare today's branch against a month-old SHA and deploy on the
      spot — which is not what "switch this back to polling" asks for. Cleared
      here so the first tick after the switch re-establishes a baseline.
    */
    if (deployTrigger !== "poll") updates.poll_sha = null;
  }

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
    /*
      `docker.mounts` is deliberately still writable from here.

      `PUT /api/projects/:id/mounts` is the way that seeds — it copies what the
      container has at that path into the host directory before the bind covers
      it — and it is what the settings tab uses. But this handler has always
      been the low-level way to set the whole contract, and a mount set through
      it is a legitimate thing to want: an empty directory the app is meant to
      write into needs no seeding, and `deploy-contract` relies on exactly that.

      Stripping the field here was tried and was wrong twice over: it silently
      dropped a value the caller had sent, and it broke a capability that works.
      What the settings form actually needed was to re-read the contract when
      the row changes, which is where the staleness lived — see `SettingsTab`.
    */
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

  /*
    Follow the switch onto GitHub.

    Turning auto-deploy on used to change a column and nothing else: the
    operator was then expected to copy a URL and a secret into GitHub's webhook
    form by hand, and every way of getting that wrong failed silently. There is
    no decision in any of those four fields — they all follow from the project —
    so when an account is connected the panel writes them itself.

    Deliberately after the column is written, and unable to undo it. This is a
    network call to a third party; a token that has not been authorised for an
    organisation must not be able to make the switch refuse to move. What it can
    do is say so, next to a switch that did.
  */
  let webhookWarning: string | null = null;

  if (autoDeploy !== undefined || deployTrigger !== undefined) {
    const row = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (row) {
      const sync = await syncAutoDeploy(row, request);
      if (sync && !sync.ok) webhookWarning = sync.message;
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
    // Same contract for the webhook: the flag is saved, GitHub may not agree.
    webhookWarning,
  });
}

/**
 * Delete a project.
 *
 * What happens to its services is the caller's call, made explicit in the
 * query string. `?services=keep` — the default — detaches them: they live on as
 * standalone services, container and data untouched, filed in the folder the
 * project was in. `?services=delete` takes them down with the project, volumes
 * included. Previously there was only the second, and the dialog could warn
 * about it but not offer anything else — so removing a project you no longer
 * needed meant losing a database you still did.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const servicesParam = request.nextUrl.searchParams.get("services") ?? "keep";
  if (servicesParam !== "keep" && servicesParam !== "delete") {
    return NextResponse.json(
      { error: "Il parametro services può essere solo keep o delete" },
      { status: 400 }
    );
  }
  const deleteServices = servicesParam === "delete";

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

  const services = await db
    .selectFrom("services")
    .select(["id", "container_name"])
    .where("project_id", "=", projectId)
    .execute();

  let volumesRemoved: string[] = [];
  let servicesKept = 0;

  if (deleteServices) {
    // Stop and remove every service container linked to this project. The
    // volumes are not passed here: `removeProjectVolumes` below takes them all
    // by label, which is both scoped and complete.
    for (const svc of services) {
      try {
        await removeService(svc.container_name);
      } catch { /* ignore */ }
    }

    // Deleting the services deletes their storage too. Previously the
    // containers went and the named volumes stayed on disk forever, invisible
    // and ready to silently reattach to a future service with the same name.
    volumesRemoved = await removeProjectVolumes(slug);
  } else {
    // Detach, the same way the services PATCH does it: off the project's
    // network, injection off (there is no app left to inject into), and into
    // the project's folder so it stays where it was on the Overview. Written
    // before the project row goes, because `services.project_id` cascades on
    // delete and would otherwise take these rows with it. The volumes stay
    // labelled with this project's slug; `removeService` finds them through
    // the container's mounts when the standalone service is deleted later.
    const inUse = new Set<string>();
    for (const svc of services) {
      for (const mount of await containerMounts(svc.container_name)) {
        if (mount.name) inUse.add(mount.name);
      }
      await disconnectFromNetwork(svc.container_name, slug);
    }
    if (services.length > 0) {
      await db
        .updateTable("services")
        .set({ project_id: null, inject_env: 0, folder_id: project.folder_id, updated_at: nowIso() })
        .where("project_id", "=", projectId)
        .execute();
    }
    servicesKept = services.length;

    // A volume of this project that no surviving service mounts belongs to a
    // service deleted "without data", kept for one recreated under the same
    // name in this project. That name includes the slug, so with the project
    // gone nothing can ever be recreated onto it: it would sit on the host
    // forever, labelled with a project no screen shows. Removed here, and only
    // here — the kept services' volumes are exactly the ones excluded.
    const orphaned = (await listOwnedVolumes({ project: slug }))
      .map((v) => v.name)
      .filter((name) => !inUse.has(name));
    volumesRemoved = await removeVolumes(orphaned);
  }

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

  return NextResponse.json({ success: true, volumesRemoved, servicesKept });
}
