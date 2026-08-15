import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  buildConnectionString,
  reachesByContainerName,
  resolveServiceEnv,
  type InjectionConflict,
  type ResolvedInjection,
} from "@/lib/service-env";
import { internalPort } from "./service-provisioner";

/**
 * The connection strings a project's linked services contribute to its
 * environment.
 *
 * Here, and not inline in the deploy pipeline, because a project is started in
 * two places and only one of them used to do this. A deploy injected
 * `DATABASE_URL` from the linked service; a restart — the Restart button, a
 * port change, and every project brought back after a reboot — rebuilt the
 * environment from `env_vars` alone and injected nothing. So the variable an
 * app received depended on whether it had last been deployed or merely started,
 * and the difference only showed up after a reboot, which is the worst possible
 * moment to discover it. An operator who trusted the link and left
 * `DATABASE_URL` unset had an app that worked until the machine rebooted and
 * then came back with no database URL at all.
 *
 * `envVars` is mutated in place, the same way `resolveServiceEnv` does it, and
 * the report is returned for the caller to log — a deploy writes it to the
 * build log, a restart has nowhere to write it and ignores it.
 */
export async function injectLinkedServiceEnv(
  project: { id: string; runtime_type: string },
  dockerNetwork: string,
  envVars: Record<string, string>
): Promise<{
  applied: ResolvedInjection[];
  skipped: string[];
  conflicts: InjectionConflict[];
}> {
  const db = await getDb();

  const linkedServices = await db
    .selectFrom("services")
    .select(["name", "type", "port", "credentials", "container_name", "inject_env", "env_key"])
    .where("project_id", "=", project.id)
    .execute();

  // Only an app on the project network resolves the service by container name.
  // On `host` the container shares the host's stack, and on `bridge` it never
  // joins the project network at all — in both cases the way in is the port
  // published on the host, exactly as for a native process.
  const onProjectNetwork = reachesByContainerName(project.runtime_type, dockerNetwork);

  return resolveServiceEnv(linkedServices, envVars, (svc) => {
    // Container name and container port travel together: inside the network the
    // published mapping does not exist, so a service published on 5433 is still
    // listening on 5432. Pairing the container name with the host port is what
    // made a database on a non-default port unreachable.
    const host = onProjectNetwork ? svc.container_name : "localhost";
    const svcPort = onProjectNetwork ? internalPort(svc.type, svc.port) : svc.port;
    let creds: { user?: string; password?: string; database?: string } = {};
    try {
      creds = JSON.parse(decrypt(svc.credentials));
    } catch {
      /* credentials unreadable — fall back to an empty URL */
    }

    return buildConnectionString(svc.type, {
      host,
      port: svcPort,
      user: creds.user,
      password: creds.password,
      database: creds.database,
    });
  });
}
