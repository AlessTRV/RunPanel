import { client, createReporter, dockerAvailable, SETUP_TOKEN } from "../harness.mjs";

/**
 * Folders on the Overview: a flat grouping for projects and for the services
 * that belong to no project.
 *
 * A folder holds nothing of its own — it is a label two columns point at — so
 * the contract worth checking is at the edges: a name has to be unique, a move
 * has to name a folder that exists, deleting a folder returns its contents to
 * the root instead of taking them along, and a service that gets linked to a
 * project leaves its folder, since from then on it shows under the project.
 *
 * The service half needs Docker (a service is a container) and runs only when
 * one is around; the folder and project half runs everywhere, on both drivers.
 */
export const meta = { name: "folders", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("folders");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "folders-suite-pw" }),
  });

  // --- create ----------------------------------------------------------------
  let res = await api.call("/api/folders");
  r.check(
    "a fresh store has no folders",
    res.status === 200 && Array.isArray(res.body) && res.body.length === 0,
    `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`
  );

  res = await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "Clienti" }) });
  r.check(
    "creating a folder answers 201 with its row",
    res.status === 201 && typeof res.body.id === "string" && res.body.name === "Clienti",
    `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`
  );
  const clienti = res.body.id;

  res = await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "  clienti " }) });
  r.check("a second folder with the same name (any case, any padding) is a 409", res.status === 409, String(res.status));

  res = await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "   " }) });
  r.check("a blank name is a 400", res.status === 400, String(res.status));

  res = await api.call("/api/folders", { method: "POST", body: JSON.stringify({ name: "Interni" }) });
  const interni = res.body.id;

  res = await api.call("/api/folders");
  r.check(
    "the list comes back sorted by name",
    Array.isArray(res.body) && res.body.map((f) => f.name).join(",") === "Clienti,Interni",
    JSON.stringify(res.body).slice(0, 160)
  );

  // --- rename ----------------------------------------------------------------
  res = await api.call(`/api/folders/${clienti}`, { method: "PATCH", body: JSON.stringify({ name: "Clienti 2026" }) });
  r.check(
    "renaming answers with the new name",
    res.status === 200 && res.body.name === "Clienti 2026",
    `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`
  );

  res = await api.call(`/api/folders/${clienti}`, { method: "PATCH", body: JSON.stringify({ name: "interni" }) });
  r.check("renaming onto another folder's name is a 409", res.status === 409, String(res.status));

  res = await api.call(`/api/folders/${clienti}`, { method: "PATCH", body: JSON.stringify({ name: "Clienti 2026" }) });
  r.check("renaming a folder to its own name is fine", res.status === 200, String(res.status));

  res = await api.call("/api/folders/does-not-exist", { method: "PATCH", body: JSON.stringify({ name: "X" }) });
  r.check("renaming an unknown folder is a 404", res.status === 404, String(res.status));

  // --- projects --------------------------------------------------------------
  res = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Sito" }) });
  const projectId = res.body.id;
  r.check("a new project starts outside any folder", res.body.folder_id === null, JSON.stringify(res.body.folder_id));

  res = await api.call(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ folderId: clienti }) });
  r.check(
    "moving a project into a folder answers 200",
    res.status === 200,
    `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`
  );

  res = await api.call("/api/projects");
  const listed = Array.isArray(res.body) ? res.body.find((p) => p.id === projectId) : undefined;
  r.check("the project list reports the folder", listed?.folder_id === clienti, JSON.stringify(listed?.folder_id));

  res = await api.call(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ folderId: "does-not-exist" }) });
  r.check("moving into an unknown folder is a 404", res.status === 404, String(res.status));

  res = await api.call(`/api/projects/${projectId}`);
  r.check("a rejected move changes nothing", res.body.folder_id === clienti, JSON.stringify(res.body.folder_id));

  res = await api.call(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ folderId: null }) });
  r.check(
    "folderId null moves the project back to the root",
    res.status === 200 && res.body.folder_id === null,
    `${res.status} ${JSON.stringify(res.body.folder_id)}`
  );

  // --- delete ----------------------------------------------------------------
  await api.call(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ folderId: clienti }) });
  res = await api.call(`/api/folders/${clienti}`, { method: "DELETE" });
  r.check("deleting a folder answers 200", res.status === 200, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);

  res = await api.call(`/api/projects/${projectId}`);
  r.check(
    "deleting a folder keeps its project and moves it to the root",
    res.status === 200 && res.body.folder_id === null,
    `${res.status} ${JSON.stringify(res.body.folder_id)}`
  );

  res = await api.call("/api/folders");
  r.check(
    "the deleted folder is gone from the list",
    Array.isArray(res.body) && !res.body.some((f) => f.id === clienti),
    JSON.stringify(res.body).slice(0, 160)
  );

  res = await api.call(`/api/folders/${clienti}`, { method: "DELETE" });
  r.check("deleting an unknown folder is a 404", res.status === 404, String(res.status));

  // --- services --------------------------------------------------------------
  if (!dockerAvailable()) {
    r.note("docker not available: the service half is skipped");
    return r.result();
  }

  res = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({ name: "folders-cache", type: "redis", version: "7", port: 55490 }),
  });
  r.check("a standalone service provisions", res.status === 201, `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
  const serviceId = res.body.id;

  if (serviceId) {
    try {
      res = await api.call(`/api/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ folderId: interni }) });
      r.check(
        "moving a standalone service into a folder answers 200 with the folder",
        res.status === 200 && res.body.folder_id === interni,
        `${res.status} ${JSON.stringify(res.body.folder_id)}`
      );

      res = await api.call("/api/services");
      const svc = Array.isArray(res.body) ? res.body.find((s) => s.id === serviceId) : undefined;
      r.check("the service list reports the folder", svc?.folder_id === interni, JSON.stringify(svc?.folder_id));

      res = await api.call(`/api/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ folderId: "does-not-exist" }) });
      r.check("moving a service into an unknown folder is a 404", res.status === 404, String(res.status));

      res = await api.call(`/api/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ projectId }) });
      r.check(
        "linking a service to a project takes it out of its folder",
        res.status === 200 && res.body.folder_id === null,
        `${res.status} ${JSON.stringify(res.body.folder_id)}`
      );

      res = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ projectId: null, folderId: interni }),
      });
      r.check(
        "detaching and filing in one request lands in the folder",
        res.status === 200 && res.body.folder_id === interni,
        `${res.status} ${JSON.stringify(res.body.folder_id)}`
      );

      await api.call(`/api/folders/${interni}`, { method: "DELETE" });
      res = await api.call(`/api/services/${serviceId}`);
      r.check("deleting a folder moves its service to the root", res.body.folder_id === null, JSON.stringify(res.body.folder_id));
    } finally {
      await api.call(`/api/services/${serviceId}`, { method: "DELETE" });
    }
  }

  return r.result();
}
