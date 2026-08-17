import { client, createReporter, sleep, SETUP_TOKEN } from "../harness.mjs";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Moving a native project's checkout to another disk.
 *
 * The move leaves a **symlink** at `data/repos/<slug>`, and that is the whole
 * reason it can be done at all: twelve places across seven files build that path
 * from a slug alone, several of them holding nothing else, and the absolute
 * paths already stored in `deployments.artifact_dir` and in the static builder's
 * start command point inside it. A symlink keeps every one of them resolving.
 *
 * So the assertion that matters is not "the files are over there" — it is "the
 * files are over there *and the old path still reaches them*".
 *
 * No Docker and no PM2: the project under test is never started, so the move
 * runs with nothing to stop and nothing to restart.
 */
export const meta = { name: "project-repo-move", needsDocker: false, drivers: ["sqlite"] };

async function waitForPhase(api, projectId, phases, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api.call(`/api/projects/${projectId}`);
    const phase = body?.repoMove?.phase;
    if (phase && phases.includes(phase)) return body;
    if (Date.now() > deadline) throw new Error(`Lo spostamento è rimasto su "${phase}"`);
    await sleep(500);
  }
}

export async function run({ base, dataDir }) {
  const r = createReporter("project-repo-move");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "repo-move-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Repo Move Suite" }),
  });
  const projectId = created.body?.id;
  const slug = created.body?.slug;
  r.check("project created", created.status === 201, JSON.stringify(created.body));

  const move = (body) =>
    api.call(`/api/projects/${projectId}/repo-path`, { method: "POST", body: JSON.stringify(body) });

  const link = join(dataDir, "repos", slug);
  const elsewhere = join(tmpdir(), `runpanel-repo-move-${Date.now()}`);
  rmSync(elsewhere, { recursive: true, force: true });

  // --- nothing on disk yet ---------------------------------------------------
  let res = await move({ path: elsewhere });
  r.check(
    "a project with no checkout says so",
    res.status === 409 && res.body.code === "no-repo",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // The checkout an upload would have produced, with a nested folder and a
  // dotfile — both are what a naive copy loses.
  mkdirSync(join(link, ".git"), { recursive: true });
  mkdirSync(join(link, "src", "deep"), { recursive: true });
  writeFileSync(join(link, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(link, "src", "deep", "file.txt"), "contenuto-originale\n");
  writeFileSync(join(link, ".env.example"), "A=1\n");

  // --- what may never be a destination --------------------------------------
  for (const [what, path] of [
    ["a relative path", "dati/progetti"],
    ["a single level", "/mnt"],
    ["a traversal", "/mnt/../etc/x"],
  ]) {
    res = await move({ path });
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  res = await move({ path: join(dataDir, "altrove") });
  r.check(
    "the panel's own data directory is refused",
    res.status === 409 && res.body.code === "inside-data-dir",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // --- the move --------------------------------------------------------------
  res = await move({ path: elsewhere });
  r.check("the move is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  let detail = await waitForPhase(api, projectId, ["done", "failed"]);
  r.check("it completes", detail.repoMove.phase === "done", JSON.stringify(detail.repoMove));

  r.check("the files are at the new location", existsSync(join(elsewhere, "src", "deep", "file.txt")));
  r.check("the dotfile came too", existsSync(join(elsewhere, ".env.example")));
  r.check("and so did .git", existsSync(join(elsewhere, ".git", "HEAD")));

  // **The assertion this suite exists for.** Everything in the panel that owns
  // a slug and not a project row still reaches the checkout through here.
  r.check("the old path is now a link", lstatSync(link).isSymbolicLink(), link);
  r.check(
    "and it still reaches the files",
    readFileSync(join(link, "src", "deep", "file.txt"), "utf8").includes("contenuto-originale")
  );
  r.check(
    "resolving it lands at the new location",
    realpathSync(link) === realpathSync(elsewhere),
    `${realpathSync(link)} vs ${realpathSync(elsewhere)}`
  );

  r.check(
    "the panel reports where it really is",
    detail.repo_location?.real === realpathSync(elsewhere),
    JSON.stringify(detail.repo_location)
  );
  r.check("and records the declaration", detail.repo_path === elsewhere, String(detail.repo_path));

  // The old copy is deliberately still there: deleting it is a separate decision.
  r.check(
    "the previous copy is kept and named",
    Boolean(detail.repoMove.leftBehind) && existsSync(detail.repoMove.leftBehind),
    String(detail.repoMove.leftBehind)
  );

  // --- a destination that already holds something ---------------------------
  const second = join(tmpdir(), `runpanel-repo-move-2-${Date.now()}`);
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "occupato.txt"), "non toccarmi\n");
  res = await move({ path: second });
  r.check(
    "a non-empty destination is refused, with a code",
    res.status === 409 && res.body.code === "destination-not-empty",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  r.check("and nothing moved", existsSync(join(elsewhere, ".git", "HEAD")));

  // --- deleting the old copy, then coming back ------------------------------
  const removed = await api.call(`/api/projects/${projectId}/repo-path`, { method: "DELETE" });
  r.check("the previous copy can be deleted", removed.status === 200, JSON.stringify(removed.body));
  r.check("and it is gone", !existsSync(removed.body.removed), String(removed.body.removed));

  res = await move({ path: null });
  r.check("going back to the default is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  detail = await waitForPhase(api, projectId, ["done", "failed"]);
  r.check("it completes", detail.repoMove.phase === "done", JSON.stringify(detail.repoMove.error));

  r.check("the checkout is a real directory again", !lstatSync(link).isSymbolicLink(), link);
  r.check(
    "with the files in it",
    readFileSync(join(link, "src", "deep", "file.txt"), "utf8").includes("contenuto-originale")
  );
  r.check("and the declaration is cleared", detail.repo_path === null, String(detail.repo_path));

  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  rmSync(elsewhere, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
  return r.result();
}
