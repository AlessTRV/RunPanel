import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * Domains and the names projects are served on, through the API.
 *
 * A test instance runs with `RUNPANEL_DISABLE_SCHEDULERS`, so its proxy reports
 * itself disabled and never touches an nginx — which is the first thing
 * checked, because the opposite would rewrite the configuration of whatever
 * nginx serves the machine running the suite. Everything else is the store's
 * contract: canonical names, uniqueness, who may do what, and what a deleted
 * project or domain takes with it. The configuration nginx gets is
 * `proxy-unit`'s business.
 */
export const meta = { name: "domains", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("domains");
  const owner = client(base);
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  const show = (res) => `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;

  await owner.call(
    "/api/auth/login",
    json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "domains-suite-pw" })
  );

  // --- the proxy, as a test instance sees it -------------------------------------
  let res = await owner.call("/api/domains");
  r.check("the page answers with no domains", res.status === 200 && Array.isArray(res.body.domains) && res.body.domains.length === 0, show(res));
  r.check("a test instance never touches nginx", res.body.proxy?.state === "disabled", show(res));

  res = await owner.call("/api/domains/proxy", json("POST", { action: "apply" }));
  r.check("applying is refused while the proxy is disabled", res.status === 409 && res.body.ok === false, show(res));
  res = await owner.call("/api/domains/proxy", json("POST", { action: "setup" }));
  r.check("so is setting it up", res.status === 409 && res.body.ok === false, show(res));
  res = await owner.call("/api/domains/proxy", json("POST", { action: "reboot" }));
  r.check("an unknown proxy action is a 400", res.status === 400, show(res));

  // --- domains ------------------------------------------------------------------
  res = await owner.call("/api/domains", json("POST", { name: " Esempio.IT. " }));
  r.check("a domain is stored canonical", res.status === 201 && res.body.name === "esempio.it", show(res));
  const domainId = res.body.id;

  res = await owner.call("/api/domains", json("POST", { name: "esempio.it" }));
  r.check("the same domain twice is a 409", res.status === 409, show(res));

  for (const bad of ["*.esempio.it", "https://esempio.it", "localhost", "10.0.0.1", "es_empio.it", "esempio.it; x"]) {
    res = await owner.call("/api/domains", json("POST", { name: bad }));
    r.check(`the domain ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call("/api/domains", { method: "POST", body: "{" });
  r.check("a body that is not JSON is a 400", res.status === 400, show(res));

  // --- a project and its names --------------------------------------------------------
  res = await owner.call("/api/projects", json("POST", { name: "Sito" }));
  const projectId = res.body.id;

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("a project without a port gets no name", res.status === 409, show(res));

  res = await owner.call(`/api/projects/${projectId}`, json("PATCH", { port: 3456 }));
  r.check("the project gets a port", res.status === 200 && res.body.port === 3456, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: " App " }));
  r.check(
    "a name is assigned, canonical, waiting for nginx",
    res.status === 201 && res.body.host?.hostname === "app.esempio.it" && res.body.host.status === "pending",
    show(res)
  );
  const hostId = res.body.host?.id;
  r.check("the answer says why it waits", res.body.proxy?.state === "disabled", show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("the same name twice is a 409", res.status === 409, show(res));
  for (const bad of ["a.b", "-x", "x y", "*"]) {
    res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: bad }));
    r.check(`the subdomain ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId: "nope", subdomain: "x" }));
  r.check("an unknown domain is a 404", res.status === 404, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`);
  r.check(
    "the project lists its name and the domains it could use",
    res.status === 200 && res.body.hosts?.length === 1 && res.body.domains?.length === 1 && res.body.hasPort === true,
    show(res)
  );
  r.check("the owner may manage domains", res.body.canManageDomains === true && res.body.restricted === false, show(res));

  res = await owner.call("/api/domains");
  r.check(
    "the Domains page lists the name with its project",
    res.body.hosts?.length === 1 && res.body.hosts[0].projectName === "Sito" && res.body.domains[0].hostCount === 1,
    show(res)
  );

  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("a domain in use is not removed", res.status === 409, show(res));

  // --- a name's own settings -------------------------------------------------------------
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("PATCH", { publicAccess: true }));
  r.check("a name can be opened to everyone", res.status === 200 && res.body.host?.publicAccess === true, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("POST", { action: "retry" }));
  r.check("a certificate is not asked for while the proxy is disabled", res.status === 409 && typeof res.body.error === "string", show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, json("POST", { action: "renew-all" }));
  r.check("an unknown action is a 400", res.status === 400, show(res));

  res = await owner.call("/api/projects", json("POST", { name: "Altro" }));
  const otherId = res.body.id;
  res = await owner.call(`/api/projects/${otherId}/hosts/${hostId}`, { method: "DELETE" });
  r.check("another project's name cannot be removed through this one", res.status === 404, show(res));

  // --- the panel's own address -------------------------------------------------------------
  res = await owner.call("/api/settings", json("PUT", { preferences: { panel_public_url: "https://panel.esempio.it" } }));
  r.check("the panel's address is set", res.status === 200, show(res));
  await owner.call(`/api/projects/${otherId}`, json("PATCH", { port: 3457 }));
  res = await owner.call(`/api/projects/${otherId}/hosts`, json("POST", { domainId, subdomain: "panel" }));
  r.check("a project cannot take the panel's address", res.status === 409, show(res));

  // --- the Let's Encrypt email ------------------------------------------------------------------
  res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: "op@esempio.it" }));
  r.check("the email is saved", res.status === 200, show(res));
  res = await owner.call("/api/domains");
  r.check("and read back", res.body.acmeEmail === "op@esempio.it", show(res));
  for (const bad of ["not-an-email", "-x@esempio.it", "a b@esempio.it"]) {
    res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: bad }));
    r.check(`the email ${JSON.stringify(bad)} is a 400`, res.status === 400, show(res));
  }
  res = await owner.call("/api/domains/settings", json("PUT", { acmeEmail: "" }));
  r.check("an empty email clears it", res.status === 200, show(res));

  // --- who may do what ----------------------------------------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "dev@example.test", hours: 1 }));
  const devId = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const dev = client(base);
  await dev.call("/api/auth/invite", json("POST", { token, password: "dev-password-1" }));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } })
  );
  res = await dev.call("/api/domains");
  r.check("without the host permission the Domains page is refused", res.status === 403, show(res));
  res = await dev.call("/api/domains", json("POST", { name: "altro.it" }));
  r.check("and so is adding a domain", res.status === 403, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts`);
  r.check("reading a project shows its names", res.status === 200 && res.body.canManageDomains === false, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "dev" }));
  r.check("read access cannot assign a name", res.status === 403, show(res));
  res = await dev.call(`/api/projects/${otherId}/hosts`);
  r.check("a project the account cannot see answers 404", res.status === 404, show(res));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "manage", terminal: false }] } })
  );
  res = await dev.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "dev" }));
  r.check("managing the project is enough to assign a name", res.status === 201, show(res));
  res = await dev.call(`/api/projects/${projectId}/hosts/${res.body.host?.id}`, { method: "DELETE" });
  r.check("and to remove it", res.status === 200, show(res));

  // --- removal ---------------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${projectId}/hosts/${hostId}`, { method: "DELETE" });
  r.check("a name is removed", res.status === 200, show(res));
  res = await owner.call(`/api/projects/${projectId}/hosts`);
  r.check("and is gone", res.body.hosts?.length === 0, show(res));

  res = await owner.call(`/api/projects/${projectId}/hosts`, json("POST", { domainId, subdomain: "app" }));
  r.check("a removed name can be assigned again", res.status === 201, show(res));
  res = await owner.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("the project is deleted", res.status === 200, show(res));
  res = await owner.call("/api/domains");
  r.check(
    "its names went with it",
    res.body.hosts?.length === 0 && res.body.domains?.find((d) => d.id === domainId)?.hostCount === 0,
    show(res)
  );

  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("an unused domain is removed", res.status === 200, show(res));
  res = await owner.call(`/api/domains/${domainId}`, { method: "DELETE" });
  r.check("removing it again is a 404", res.status === 404, show(res));

  return r.result();
}
