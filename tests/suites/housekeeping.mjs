import { client, createReporter, docker, sleep, waitForDeploy } from "../harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Docker housekeeping.
 *
 * Nothing used to reclaim anything: every redeploy orphaned a full image, and a
 * deleted service left its named volume — and its data — on disk forever. These
 * assertions are the reason that is now false.
 *
 * The "leaves what is not ours alone" checks matter as much as the cleanup
 * ones: a garbage collector scoped by name prefix instead of ownership labels
 * would eventually delete a user's unrelated containers.
 */
export const meta = { name: "housekeeping", needsDocker: true, drivers: ["sqlite"] };

export async function run({ base, dataDir }) {
  const r = createReporter("housekeeping");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: "housekeeping-pw" }),
  });

  // --- image retention -----------------------------------------------------
  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Housekeeping Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;

  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });

  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ runtimeType: "docker", sourceType: "upload" }),
  });

  const outcomes = [];
  for (const marker of ["one", "two", "three"]) {
    // A different layer each round, so the previous image really becomes
    // orphanable rather than being reused from cache.
    writeFileSync(join(repo, "Dockerfile"), `FROM alpine
RUN echo "${marker}" > /marker
CMD ["sh","-c","while true; do sleep 1; done"]
`);
    await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
    outcomes.push(await waitForDeploy(api, projectId));
  }
  r.note(`deploy outcomes: ${outcomes.join(", ")}`);
  r.check("three consecutive deploys all reached running",
    outcomes.every((o) => o === "running"), outcomes.join(","));

  // Retention runs after the project is reported as running, so the panel shows
  // "running" as soon as it is rather than waiting on housekeeping. The
  // guarantee is therefore that it converges, not that it has already finished
  // the instant the deploy ends — asserting the latter is a race.
  const listTags = () =>
    docker("images", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Repository}}:{{.Tag}}")
      .split("\n").filter(Boolean);

  let tags = listTags();
  for (let i = 0; i < 30 && tags.filter((t) => !t.endsWith(":current")).length > 2; i++) {
    await sleep(1000);
    tags = listTags();
  }
  r.note(`images: ${tags.join(", ") || "(none)"}`);

  const versioned = tags.filter((t) => !t.endsWith(":current"));
  r.check("retention converges to at most 2 versioned images", versioned.length <= 2, `${versioned.length}`);
  r.check("a :current alias exists", tags.some((t) => t.endsWith(":current")), tags.join(","));

  const dangling = docker("images", "--filter", "label=runpanel.managed=true", "--filter", "dangling=true", "--format", "{{.ID}}")
    .split("\n").filter(Boolean);
  r.check("no dangling RunPanel images left behind", dangling.length === 0, `${dangling.length} dangling`);

  // --- monitor throughput --------------------------------------------------
  await api.call("/api/monitor");
  const warm = Date.now();
  await api.call("/api/monitor");
  const elapsed = Date.now() - warm;
  r.note(`/api/monitor warm response: ${elapsed}ms`);
  r.check("monitor responds well inside its 3s poll interval", elapsed < 1500, `${elapsed}ms`);

  // --- orphans -------------------------------------------------------------
  docker("rm", "-f", "runpanel-test-ghost");
  docker("run", "-d", "--name", "runpanel-test-ghost",
    "--label", "runpanel.managed=true", "--label", "runpanel.project=no-such-project",
    "alpine", "sh", "-c", "while true; do sleep 1; done");

  docker("rm", "-f", "not-ours-test");
  docker("run", "-d", "--name", "not-ours-test", "alpine", "sh", "-c", "while true; do sleep 1; done");

  const storage = await api.call("/api/storage");
  r.check("storage reports docker available", storage.body.dockerAvailable === true);
  r.check("an owned container with no project is flagged as orphaned",
    storage.body.orphans?.containers?.includes("runpanel-test-ghost"),
    JSON.stringify(storage.body.orphans?.containers));
  r.check("an unlabelled container is NOT treated as ours",
    !storage.body.orphans?.containers?.includes("not-ours-test"),
    JSON.stringify(storage.body.orphans?.containers));

  const swept = await api.call("/api/storage", {
    method: "POST",
    body: JSON.stringify({ removeOrphans: true }),
  });
  r.check("sweep removed the orphan", swept.body.containers?.includes("runpanel-test-ghost"),
    JSON.stringify(swept.body.containers));
  r.check("sweep left the unrelated container alone",
    docker("ps", "-a", "--filter", "name=not-ours-test", "--format", "{{.Names}}").includes("not-ours-test"));

  docker("rm", "-f", "not-ours-test", "runpanel-test-ghost");

  // --- volumes -------------------------------------------------------------
  const svc = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({ name: "db", type: "postgresql", version: "16", port: 55480, projectId }),
  });
  r.check("service provisioned", svc.status === 201, `${svc.status} ${JSON.stringify(svc.body).slice(0, 140)}`);

  if (svc.status === 201) {
    const volumes = docker("volume", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}");
    r.check("volume created WITH ownership labels", volumes.length > 0, `"${volumes}"`);

    // A plain delete must keep the data: dropping a database's storage is not
    // something to do as a side effect.
    await api.call(`/api/services/${svc.body.id}`, { method: "DELETE" });
    const kept = docker("volume", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}");
    r.check("a plain delete KEEPS the data volume", kept.length > 0, `"${kept}"`);

    const svc2 = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({ name: "db", type: "postgresql", version: "16", port: 55480, projectId }),
    });
    await api.call(`/api/services/${svc2.body.id}?deleteData=true`, { method: "DELETE" });
    const gone = docker("volume", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}");
    r.check("deleteData=true removes the volume", gone.length === 0, `"${gone}"`);
  }

  // --- project delete takes everything ------------------------------------
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  const leftImages = docker("images", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.ID}}");
  const leftVolumes = docker("volume", "ls", "--filter", `label=runpanel.project=${slug}`, "--format", "{{.Name}}");
  r.check("deleting the project removed its images", leftImages.length === 0, `"${leftImages}"`);
  r.check("deleting the project removed its volumes", leftVolumes.length === 0, `"${leftVolumes}"`);

  return r.result();
}
