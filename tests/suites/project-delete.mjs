import { client, createReporter, docker, SETUP_TOKEN } from "../harness.mjs";

/**
 * What happens to a project's services when the project goes — over HTTP.
 *
 * Deleting a project used to take the databases with it, volumes included, and
 * the dialog offered nothing else. Now the default keeps them: the services are
 * detached and live on as standalone, container and data untouched. Destroying
 * them is the opt-in, `?services=delete`, in the same spirit as the service
 * route's `?deleteData=true`.
 *
 * Also covers the consequence that made "keep" safe to offer: a detached
 * service's volumes are still named after the project it came from, so a later
 * "delete with data" on the standalone service has to find them by asking
 * Docker what the container mounts, not by rebuilding a name that no longer
 * has a project slug in it.
 *
 * Needs Docker because every one of these questions is about what is left on
 * the host afterwards.
 */
export const meta = { name: "project-delete", needsDocker: true, drivers: ["sqlite"] };

function volumesOf(slug) {
  return docker("volume", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}")
    .split("\n")
    .filter(Boolean);
}

function networksOf(slug) {
  return docker("network", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}")
    .split("\n")
    .filter(Boolean);
}

function running(containerName) {
  return docker("inspect", containerName, "--format", "{{.State.Running}}");
}

async function createProjectWithCache(api, name, serviceName, port) {
  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const service = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: serviceName,
      type: "redis",
      version: "7",
      port,
      projectId: project.body.id,
      credentials: { password: "project-delete-pw" },
    }),
  });
  return { project, service };
}

export async function run({ base }) {
  const r = createReporter("project-delete");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "project-delete-pw" }),
  });

  // --- default: the project goes, its services stay ---------------------------
  {
    const { project, service } = await createProjectWithCache(api, "Delete Keep", "kept", 55520);
    r.check("a project with a cache is set up", project.status === 201 && service.status === 201,
      `${project.status} / ${service.status} ${JSON.stringify(service.body).slice(0, 140)}`);
    if (project.status !== 201 || service.status !== 201) return r.result();

    const { id: projectId, slug } = project.body;
    const { id: serviceId, container_name: containerName } = service.body;

    const before = volumesOf(slug);
    r.check("the service's volume carries the project label", before.length > 0, before.join(", ") || "(nessuno)");

    // A second service, deleted the plain way: its volume is kept for a service
    // recreated under the same name inside this project. Once the project is
    // gone that name can never be built again, so the volume would sit on the
    // host forever, labelled with a project no screen shows.
    const orphaned = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({
        name: "left-behind",
        type: "redis",
        version: "7",
        port: 55522,
        projectId,
        credentials: { password: "project-delete-pw" },
      }),
    });
    r.check("a second service is set up", orphaned.status === 201, String(orphaned.status));
    await api.call(`/api/services/${orphaned.body.id}`, { method: "DELETE" });
    const withOrphan = volumesOf(slug);
    r.check("a plain delete leaves its volume behind", withOrphan.length === before.length + 1, withOrphan.join(", "));

    try {
      const stranger = await client(base).call(`/api/projects/${projectId}`, { method: "DELETE" });
      r.check("DELETE requires a session", stranger.status === 401, String(stranger.status));

      const deleted = await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
      r.check("deleting the project succeeds", deleted.status === 200, `${deleted.status} ${JSON.stringify(deleted.body).slice(0, 120)}`);
      r.check("and reports it kept the services", deleted.body.servicesKept === 1, JSON.stringify(deleted.body));
      r.check("and removed only the orphaned volume", Array.isArray(deleted.body.volumesRemoved) && deleted.body.volumesRemoved.length === 1,
        JSON.stringify(deleted.body.volumesRemoved));

      const gone = await api.call(`/api/projects/${projectId}`);
      r.check("the project is gone", gone.status === 404, String(gone.status));

      const survivor = await api.call(`/api/services/${serviceId}`);
      r.check("the service survives", survivor.status === 200, String(survivor.status));
      r.check("as a standalone one", survivor.body.project_id === null, String(survivor.body.project_id));
      r.check("with its injection off", survivor.body.injectEnv === false, String(survivor.body.injectEnv));

      r.check("its container is still running", running(containerName) === "true", running(containerName) || "(assente)");
      r.check("and its volume is still there", volumesOf(slug).length === before.length, volumesOf(slug).join(", ") || "(nessuno)");
      r.check("while the project network is gone", networksOf(slug).length === 0, networksOf(slug).join(", "));

      // --- and the standalone service can still take its data with it ---------
      const withData = await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
      r.check("deleting the standalone service with its data succeeds", withData.status === 200, String(withData.status));
      r.check("and it finds the volume named after the dead project", (withData.body.volumesRemoved ?? []).length === before.length,
        JSON.stringify(withData.body.volumesRemoved));
      r.check("so nothing is left on the host", volumesOf(slug).length === 0, volumesOf(slug).join(", "));
    } finally {
      await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
      await api.call(`/api/projects/${projectId}?services=delete`, { method: "DELETE" });
      for (const name of volumesOf(slug)) docker("volume", "rm", name);
    }
  }

  // --- opt-in: everything goes -------------------------------------------------
  {
    const { project, service } = await createProjectWithCache(api, "Delete All", "doomed", 55521);
    r.check("a second project with a cache is set up", project.status === 201 && service.status === 201,
      `${project.status} / ${service.status}`);
    if (project.status !== 201 || service.status !== 201) return r.result();

    const { id: projectId, slug } = project.body;
    const { id: serviceId, container_name: containerName } = service.body;
    const before = volumesOf(slug);

    try {
      const deleted = await api.call(`/api/projects/${projectId}?services=delete`, { method: "DELETE" });
      r.check("deleting the project with its services succeeds", deleted.status === 200, `${deleted.status} ${JSON.stringify(deleted.body).slice(0, 120)}`);
      r.check("and reports it kept none", deleted.body.servicesKept === 0, JSON.stringify(deleted.body));
      r.check("and removed the volumes", (deleted.body.volumesRemoved ?? []).length === before.length, JSON.stringify(deleted.body.volumesRemoved));

      r.check("the service is gone", (await api.call(`/api/services/${serviceId}`)).status === 404);
      r.check("its container is gone", running(containerName) === "", running(containerName));
      r.check("and so is its volume", volumesOf(slug).length === 0, volumesOf(slug).join(", "));
    } finally {
      await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
      await api.call(`/api/projects/${projectId}?services=delete`, { method: "DELETE" });
      for (const name of volumesOf(slug)) docker("volume", "rm", name);
    }
  }

  // --- a value that is neither is refused before anything is touched ----------
  {
    const project = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Delete Typo" }) });
    const projectId = project.body.id;
    try {
      const bad = await api.call(`/api/projects/${projectId}?services=maybe`, { method: "DELETE" });
      r.check("an unknown services value is a 400", bad.status === 400, String(bad.status));
      r.check("and the project is untouched", (await api.call(`/api/projects/${projectId}`)).status === 200);
    } finally {
      await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
    }
  }

  return r.result();
}
