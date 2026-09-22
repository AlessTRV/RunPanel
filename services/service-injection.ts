import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  connectionOrigin,
  resolveServiceEnv,
  serviceConnectionUrl,
  serviceEndpoint,
  type ConnectionOrigin,
  type InjectionConflict,
  type ResolvedInjection,
} from "@/lib/service-env";
import { networkName } from "./docker/labels";
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
  /**
   * Where the app calls from. A deploy passes the contract's network mode; a
   * compose deploy passes `host` only when the whole stack runs on
   * `network_mode: host`, which is the one case a container reaches the
   * service like a native process would.
   */
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

  // One rule for every runtime, in `lib/service-env.ts`: a container reaches
  // the service by name on the project network, a native process on the port
  // published on the host. The pipeline and the drivers put every container
  // runtime on that network, so the name always resolves.
  const from = connectionOrigin(project.runtime_type, dockerNetwork);

  return resolveServiceEnv(linkedServices, envVars, (svc) => {
    let creds: { user?: string; password?: string; database?: string } = {};
    try {
      creds = JSON.parse(decrypt(svc.credentials));
    } catch {
      /* credentials unreadable — fall back to an empty URL */
    }

    return serviceConnectionUrl(
      {
        type: svc.type,
        port: svc.port,
        internalPort: internalPort(svc.type, svc.port),
        containerName: svc.container_name,
        credentials: creds,
      },
      null,
      { from }
    );
  });
}

/**
 * What a link will hand over, without the credentials — for the pages.
 *
 * The project page prints it under the variable name so the operator can see
 * which host the app is about to receive; the service page uses `from` to
 * preselect the matching line. Both read this rather than restating the rule,
 * which is how they used to disagree with the deploy.
 */
export interface InjectionDescription {
  from: ConnectionOrigin;
  host: string;
  port: number;
  /** The network the name resolves on; null when reached from the host. */
  network: string | null;
}

export function describeInjection(
  service: { type: string; port: number; container_name: string },
  project: { slug: string; runtime_type: string; dockerNetwork?: string | null } | null | undefined
): InjectionDescription | null {
  if (!project) return null;

  const from = connectionOrigin(project.runtime_type, project.dockerNetwork);
  const { host, port } = serviceEndpoint(
    {
      type: service.type,
      port: service.port,
      internalPort: internalPort(service.type, service.port),
      containerName: service.container_name,
    },
    from
  );

  return { from, host, port, network: from === "container" ? networkName(project.slug) : null };
}
