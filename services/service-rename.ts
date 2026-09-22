import { getDb, nowIso } from "@/lib/db";
import type { ServicesTable } from "@/lib/db/schema";
import {
  aliasesAfterRename,
  parseAliases,
  planContainerRename,
  serviceDisplayName,
  technicalServiceName,
} from "@/lib/service-name";
import { docker, dockerTry } from "./docker/cli";
import { LABEL_PROJECT, LABEL_SERVICE, serviceContainerName } from "./docker/labels";
import type { AccessRow } from "./access";
import { currentVolumeSources, provisionService, serviceRunConfig } from "./service-provisioner";

/**
 * The containers of a project's services, made to follow the names the
 * operator gave them.
 *
 * Run by the deploy, and only there, because it restarts the database: the
 * deploy is the moment the operator already chose for their app to restart,
 * and the app is about to be started with the new host anyway. Only services
 * that were given a name are touched — a container whose name merely differs
 * from what the derivation would produce today (an older naming, a service
 * moved between projects) is left exactly as it is.
 *
 * The data never moves. The replacement mounts the volumes the old container
 * had, asked of Docker, and the old name stays on the project network as an
 * alias: the app still running from the previous deploy — or left running by
 * a deploy that fails further on — keeps reaching its database under the host
 * it was started with.
 */
export async function alignServiceNames(
  project: { id: string; slug: string },
  log: (line: string) => void
): Promise<void> {
  const db = await getDb();
  const all = await db.selectFrom("services").selectAll().execute();
  const renamed = all.filter((service) => service.project_id === project.id && service.display_name);

  for (const service of renamed) {
    const label = serviceDisplayName(service);
    const technical = technicalServiceName(service.display_name ?? "");
    const desired = technical ? serviceContainerName(technical, project.slug) : null;

    const taken = new Set<string>();
    for (const other of all) {
      if (other.id === service.id) continue;
      taken.add(other.container_name);
      for (const alias of parseAliases(other.network_aliases)) taken.add(alias);
    }

    // A container of that name the panel knows nothing about is somebody
    // else's, and is never removed to make room. One labelled as this very
    // service is what an interrupted rename left behind, and is replaced.
    if (desired && desired !== service.container_name && !taken.has(desired)) {
      const existing = await dockerTry(
        [
          "inspect", "--format",
          `{{with index .Config.Labels "${LABEL_SERVICE}"}}{{.}}{{end}}|{{with index .Config.Labels "${LABEL_PROJECT}"}}{{.}}{{end}}`,
          desired,
        ],
        { timeout: 15_000 }
      );
      if (existing) {
        const [serviceLabel, projectLabel] = existing.stdout.trim().split("|");
        if (serviceLabel !== service.name || projectLabel !== project.slug) taken.add(desired);
      }
    }

    const plan = planContainerRename({ containerName: service.container_name, desired, taken });
    if (plan.action === "keep") continue;
    if (plan.action === "blocked") {
      log(`Servizio ${label}: il container resta ${service.container_name} — ${plan.reason}`);
      continue;
    }

    try {
      await renameContainer(service, project.slug, plan.to, log);
    } catch (err) {
      // Never the reason a deploy fails: the service is where it was, under
      // the name it had, and the app is handed that name.
      log(
        `Servizio ${label}: non sono riuscito a rinominare il container, resta ${service.container_name} ` +
          `(${err instanceof Error ? err.message : String(err)})`
      );
    }
  }
}

async function isRunning(container: string): Promise<boolean | null> {
  const state = await dockerTry(["inspect", "--format", "{{.State.Running}}", container], { timeout: 15_000 });
  return state ? state.stdout.trim() === "true" : null;
}

async function renameContainer(
  service: ServicesTable,
  projectSlug: string,
  to: string,
  log: (line: string) => void
): Promise<void> {
  const from = service.container_name;
  const running = await isRunning(from);
  const volumeSources = running === null ? undefined : await currentVolumeSources(from);
  const aliases = aliasesAfterRename(parseAliases(service.network_aliases), from, to);
  const access: AccessRow = {
    access_mode: service.access_mode,
    access_allow: service.access_allow,
    access_port: service.access_port,
  };

  const volumes = Object.values(volumeSources ?? {});
  log(
    `Servizio ${serviceDisplayName(service)}: il container ${from} diventa ${to}` +
      (volumes.length > 0 ? `; i dati restano in ${volumes.join(", ")}` : "") +
      `; ${from} resta raggiungibile come alias`
  );

  // The old container holds the port, so it has to stop before the new one
  // can publish it. Stopped, not removed: if the replacement cannot start, the
  // original comes straight back.
  if (running) await docker(["stop", from], { timeout: 120_000 });

  try {
    await provisionService(serviceRunConfig(service, projectSlug), projectSlug, access, {
      containerName: to,
      volumeSources,
      aliases,
    });
  } catch (err) {
    if (running) await dockerTry(["start", from], { timeout: 60_000 });
    throw err;
  }

  // Only the container. `rm` without `-v` leaves every named volume where it is.
  if (running !== null) await dockerTry(["rm", from], { timeout: 30_000 });

  const db = await getDb();
  await db
    .updateTable("services")
    .set({ container_name: to, network_aliases: JSON.stringify(aliases), updated_at: nowIso() })
    .where("id", "=", service.id)
    .execute();

  // A service that was stopped goes back to being stopped: it starts for a
  // moment on the way, like any recreate.
  if (running === false || (running === null && service.status !== "running")) {
    await dockerTry(["stop", to], { timeout: 60_000 });
  }
}
