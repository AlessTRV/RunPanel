import { getDb } from "./db";
import { projectAccess, serviceAccess, type Principal } from "./authz";
import { projectRefs, serviceRefs } from "./principal";

/**
 * How far the `backup` and `restore` permissions reach for someone who is not
 * the owner.
 *
 * An archive is a copy of data, so holding `backup` must not become a way to
 * read what no grant opened: a policy over the panel's own store, or one that
 * carries the secret key, hands over every password hash and every credential
 * the panel can decrypt. For anyone but the owner, a policy may only name
 * projects and services they manage, one by one — no `all-*` selector, no
 * `panel`, no secret key — and they see only policies and runs of that shape.
 */

type Target = { kind: string; id?: string };

async function manageable(principal: Principal) {
  const projects = await projectRefs();
  const services = await serviceRefs(projects);
  return {
    project: (id: string) => {
      const ref = projects.get(id);
      return ref !== undefined && projectAccess(principal, ref).level === "manage";
    },
    service: (id: string) => {
      const ref = services.get(id);
      return ref !== undefined && serviceAccess(principal, ref).level === "manage";
    },
  };
}

/** Why a policy of this shape is not theirs to create or run, or null. */
export async function policyProblem(
  principal: Principal,
  targets: readonly Target[],
  includeSecretKey: boolean
): Promise<string | null> {
  if (principal.isOwner) return null;
  if (includeSecretKey) return "Solo il proprietario può includere la chiave segreta in un backup";
  const can = await manageable(principal);
  for (const target of targets) {
    if (target.kind === "project" && target.id && can.project(target.id)) continue;
    if (target.kind === "service" && target.id && can.service(target.id)) continue;
    return target.kind === "panel" || target.kind.startsWith("all-")
      ? "Solo il proprietario può fare il backup del pannello o di tutti i progetti e servizi"
      : "Puoi fare il backup solo dei progetti e servizi che gestisci";
  }
  return null;
}

export async function policyVisible(principal: Principal, targets: readonly Target[], includeSecretKey: boolean) {
  return (await policyProblem(principal, targets, includeSecretKey)) === null;
}

/** Policies a non-owner may see, by id. `"all"` for the owner. */
export async function visiblePolicyIds(principal: Principal): Promise<Set<string> | "all"> {
  if (principal.isOwner) return "all";
  const db = await getDb();
  const rows = await db.selectFrom("backup_policies").select(["id", "targets", "include_secret_key"]).execute();
  const out = new Set<string>();
  for (const row of rows) {
    let targets: Target[] = [];
    try {
      targets = JSON.parse(row.targets) as Target[];
    } catch {
      continue;
    }
    if (await policyVisible(principal, targets, row.include_secret_key === 1)) out.add(row.id);
  }
  return out;
}

/** A run belongs to whoever may see its policy; a run with no policy is the owner's. */
export async function runVisible(principal: Principal, runId: string): Promise<boolean> {
  if (principal.isOwner) return true;
  const db = await getDb();
  const run = await db.selectFrom("backup_runs").select("policy_id").where("id", "=", runId).executeTakeFirst();
  if (!run?.policy_id) return false;
  const visible = await visiblePolicyIds(principal);
  return visible === "all" || visible.has(run.policy_id);
}

/**
 * Why this restore is not theirs, or null. A non-owner restores only from a
 * run they can see, never from an uploaded archive, never the panel's store,
 * and only onto projects and services they manage.
 */
export async function restoreProblem(
  principal: Principal,
  request: { runId?: string; uploadId?: string; targets: ReadonlyArray<{ artifactId: string; action: string; targetId?: string }> }
): Promise<string | null> {
  if (principal.isOwner) return null;
  if (!request.runId || request.uploadId) return "Solo il proprietario può ripristinare da un archivio caricato";
  if (!(await runVisible(principal, request.runId))) return "Backup non trovato";

  const db = await getDb();
  const artifacts = new Map(
    (await db.selectFrom("backup_artifacts").select(["id", "kind", "ref_id"]).where("run_id", "=", request.runId).execute()).map(
      (a) => [a.id, a]
    )
  );
  const can = await manageable(principal);
  for (const mapping of request.targets) {
    if (mapping.action !== "restore") continue;
    const artifact = artifacts.get(mapping.artifactId);
    if (!artifact) return "L'elemento selezionato non appartiene a questo backup";
    const target = mapping.targetId ?? artifact.ref_id;
    if (!target) return "Destinazione del ripristino mancante";
    const ok =
      artifact.kind === "service-db" ? can.service(target) : artifact.kind.startsWith("project-") ? can.project(target) : false;
    if (!ok) return "Puoi ripristinare solo su progetti e servizi che gestisci";
  }
  return null;
}

/** A restore is visible to whoever may see the run it restored from. */
export async function restoreVisible(principal: Principal, restoreId: string): Promise<boolean> {
  if (principal.isOwner) return true;
  const db = await getDb();
  const row = await db.selectFrom("restore_runs").select("run_id").where("id", "=", restoreId).executeTakeFirst();
  return Boolean(row?.run_id) && (await runVisible(principal, row!.run_id!));
}
