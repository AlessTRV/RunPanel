import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The bind list on a project, and the two ways it must not be writable.
 *
 * `docker.mounts` has been in the deploy contract from the beginning and has
 * always reached `docker run -v`, with no interface and no validation. Adding
 * both raises a question the service side never had: the settings form also
 * writes the contract, so it could revert a list edited elsewhere — or, far
 * worse, add a bind with no copy in front of it, which shows the app an empty
 * folder where its files were.
 *
 * So the list is written by one route only, and the assertions below are that
 * rule. No Docker: everything here is refused before anything would be started.
 */
export const meta = { name: "project-mounts", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base }) {
  const r = createReporter("project-mounts");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "project-mounts-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Mounts Suite" }),
  });
  const projectId = created.body?.id;
  r.check("project created", created.status === 201, JSON.stringify(created.body));

  const put = (body) =>
    api.call(`/api/projects/${projectId}/mounts`, { method: "PUT", body: JSON.stringify(body) });

  // --- a bind is a container concept ----------------------------------------
  let res = await put({ mounts: [] });
  r.check(
    "a native project has no container to bind into",
    res.status === 409 && res.body.code === "runtime-not-docker",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ runtimeType: "docker" }),
  });

  // --- what may never be bound ----------------------------------------------
  for (const [what, mount] of [
    ["a relative host path", { source: "mnt/dati", target: "/app/x" }],
    ["a traversal", { source: "/mnt/../etc", target: "/app/x" }],
    ["a single-level host path", { source: "/mnt", target: "/app/x" }],
    ["a system directory", { source: "/etc/app", target: "/app/x" }],
    ["docker's own state", { source: "/var/lib/docker/x", target: "/app/x" }],
    ["a windows host path", { source: "C:\\dati", target: "/app/x" }],
    ["the container root", { source: "/mnt/dati/x", target: "/" }],
    ["a kernel filesystem", { source: "/mnt/dati/x", target: "/proc/self" }],
  ]) {
    res = await put({ mounts: [{ ...mount, enabled: true, readOnly: false }] });
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  res = await put({
    mounts: [
      { source: "/mnt/dati/uno", target: "/app/dati", enabled: true, readOnly: false },
      { source: "/mnt/dati/due", target: "/app/dati", enabled: true, readOnly: false },
    ],
  });
  r.check("two binds on one container path are refused", res.status === 400,
    `${res.status} ${JSON.stringify(res.body)}`);

  // --- nothing to copy out of yet -------------------------------------------
  //
  // Seeding reads what the container has now. Before the first deploy there is
  // no image, and saying so is better than binding an empty folder in silence.
  res = await put({
    mounts: [{ source: "/mnt/dati/uploads", target: "/app/uploads", enabled: true, readOnly: false }],
  });
  r.check(
    "a project never deployed says there is nothing to copy",
    res.status === 409 && res.body.code === "no-image",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // --- the contract is still the low-level way in ---------------------------
  //
  // `PUT …/mounts` is the way that seeds. This handler stays writable, because
  // an empty directory the app is meant to write into needs no seeding and
  // setting one that way is a legitimate thing to want — `deploy-contract`
  // relies on exactly that. Stripping the field here was tried and broke it.
  const before = await api.call(`/api/projects/${projectId}`);
  r.check("the list starts empty", Array.isArray(before.body.mounts) && before.body.mounts.length === 0,
    JSON.stringify(before.body.mounts));

  const patched = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      builderConfig: { version: 1, docker: { mounts: ["/mnt/dati/uploads:/app/uploads"] } },
    }),
  });
  r.check("a contract carrying a mount is accepted", patched.status === 200, String(patched.status));

  const after = await api.call(`/api/projects/${projectId}`);
  r.check(
    "and the panel reads it back as a row",
    after.body.mounts?.length === 1 &&
      after.body.mounts[0].source === "/mnt/dati/uploads" &&
      after.body.mounts[0].target === "/app/uploads",
    JSON.stringify(after.body.mounts)
  );
  r.check(
    "with the switch on, because a stored mount is one docker already gets",
    after.body.mounts?.[0]?.enabled === true,
    JSON.stringify(after.body.mounts)
  );

  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
