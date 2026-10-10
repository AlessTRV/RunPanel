import { NextResponse } from "next/server";

import { getDb } from "./db";
import { hasPermission, needsHost, type Principal } from "./authz";
import { parseContractJson } from "./deploy-contract";

/**
 * Where `manage` on a project stops short of the machine.
 *
 * Without the `host` permission, nobody but the owner may:
 * - change what code a project runs — its files, an upload, its repository —
 *   because the repository's own `runpanel.json` can add bind mounts and
 *   capabilities, and a native project runs that code on the host directly;
 * - touch host paths — mounts, the checkout location;
 * - run one-time commands, which run where the project runs;
 * - change the runtime, the deploy contract or the variables of a project that
 *   reaches the host (see `needsHost`), or make one that does.
 * A plain container stays fully theirs to configure, deploy and restart.
 */

const denied = (what: string) =>
  NextResponse.json(
    { error: `Serve il permesso "Accesso all'host": ${what}`, code: "host_required" },
    { status: 403 }
  );

export function projectReachesHost(row: { runtime_type: string; builder_config: string }): boolean {
  const contract = parseContractJson(row.builder_config);
  return needsHost({
    runtimeType: row.runtime_type,
    network: contract.docker.network,
    capAdd: contract.docker.capAdd,
    mounts: contract.docker.mounts,
  });
}

/** For actions that need the permission whatever the project is. */
export function requireHostFor(principal: Principal, what: string): NextResponse | null {
  return hasPermission(principal, "host") ? null : denied(what);
}

/**
 * For configuration changes: allowed without the permission only while the
 * project, before and after the change, stays a plain container.
 */
export async function requireHostIfReaching(
  principal: Principal,
  projectId: string,
  what: string,
  next?: { runtimeType?: string | null; builderConfig?: string }
): Promise<NextResponse | null> {
  if (hasPermission(principal, "host")) return null;
  const db = await getDb();
  const row = await db
    .selectFrom("projects")
    .select(["runtime_type", "builder_config"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!row) return null;
  const after = {
    runtime_type: next?.runtimeType ?? row.runtime_type,
    builder_config: next?.builderConfig ?? row.builder_config,
  };
  return projectReachesHost(row) || projectReachesHost(after) ? denied(what) : null;
}
