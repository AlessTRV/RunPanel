import { getDb, nowIso } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { parseContractJson } from "@/lib/deploy-contract";
import { listenPort, readAccess } from "@/lib/access-columns";
import { processManager } from "./process-manager";
import { projectEvents } from "./events";
import { checkLoopbackLeak, forgetLeak, syncGate } from "./access";

/**
 * Start a project again from its last successful build.
 *
 * Extracted because there were two ways to reach it and only one of them was
 * right. `POST /control` replayed a deployment with nothing but `start_cmd`,
 * `cwd`, `env` and `port`, dropping the whole contract: a project deployed with
 * `network: host` came back on the project network, one with bind mounts came
 * back without them, and a `restartPolicy` of `no` came back as
 * `unless-stopped`. Pressing Restart quietly changed how the app ran.
 *
 * Restricting a port needs exactly this operation — the listener has to move —
 * so rather than add a second lossy copy, both go through here.
 */
export async function restartFromLastDeployment(
  projectId: string
): Promise<{ success: true } | { error: string }> {
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return { error: "Progetto non trovato" };

  const lastDeploy = await db
    .selectFrom("deployments")
    .select(["start_cmd", "artifact_dir"])
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .where("start_cmd", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!lastDeploy?.start_cmd || !lastDeploy.artifact_dir) {
    return { error: "Non c'è nessun deploy riuscito da riavviare. Fai prima un deploy." };
  }

  const envRows = await db
    .selectFrom("env_vars")
    .select(["key", "value"])
    .where("project_id", "=", projectId)
    .execute();

  const envVars: Record<string, string> = {};
  for (const row of envRows) {
    envVars[row.key] = decrypt(row.value);
  }

  const contract = parseContractJson(project.builder_config);
  const port = project.port ?? 3000;
  const access = readAccess(project);

  // The gate holds the public port. It has to let go before the app can take it
  // back, and it is reopened below once the app is on the loopback port.
  const { closeGate } = await import("./access-gate");
  await closeGate("project", projectId);

  // The driver empties the process output before launching, so tell any open
  // viewer to do the same rather than leave it showing the previous run.
  projectEvents.emit(projectId, { type: "process:reset" });

  await processManager.start(project.slug, lastDeploy.start_cmd, project.runtime_type, {
    cwd: lastDeploy.artifact_dir,
    env: envVars,
    port,
    loopbackPort: access.mode === "restricted" ? listenPort(project, port) : undefined,
    restartPolicy: contract.runtime.restartPolicy,
    network: contract.docker.network,
    hostname: contract.docker.hostname,
    capAdd: contract.docker.capAdd,
    extraHosts: contract.docker.extraHosts,
    mounts: contract.docker.mounts,
    memory: contract.runtime.memory,
    cpus: contract.runtime.cpus,
    shmSize: contract.runtime.shmSize,
  });

  await db
    .updateTable("projects")
    .set({ status: "running", updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();

  // After the app, never before: while the old process still holds the public
  // port, binding it is an EADDRINUSE rather than a gate.
  await syncGate("project", projectId, project, { publicPort: project.port, label: project.name });

  if (access.mode === "restricted" && access.port) {
    // Not awaited: it takes a few seconds by design, and the answer is a notice
    // on a page, not something the restart has to wait for.
    void checkLoopbackLeak(projectId, access.port);
  } else {
    forgetLeak(projectId);
  }

  return { success: true };
}
