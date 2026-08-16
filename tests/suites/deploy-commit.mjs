import { client, createReporter, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Deploying one specific commit, and being held there.
 *
 * The interesting half of this feature is what a browser is allowed to send:
 * the commit travels from a form into `execFile("git", [...])`, where an
 * argument beginning with a hyphen is an option and `--upload-pack=<cmd>` is
 * command execution on the host. There is no shell to escape — the accepted
 * character set is the whole defence — so the refusals below are the point of
 * the suite, not its preamble.
 *
 * A project with no source deploys and fails in milliseconds, which is what
 * makes the rest testable without a real remote.
 */
export const meta = { name: "deploy-commit", needsDocker: false, drivers: ["sqlite", "postgres"] };

const SHA = "a".repeat(40);

export async function run({ base }) {
  const r = createReporter("deploy-commit");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "commit-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Commit Suite" }),
  });
  const projectId = created.body.id;
  r.check("project created", Boolean(projectId), JSON.stringify(created.body));

  const deploy = (body) =>
    api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: JSON.stringify(body) });

  // --- what may never reach git as an argument -----------------------------
  const hostile = [
    ["a value that is not hex", "zzzz"],
    ["an option pretending to be a sha", "-upload-pack=touch /tmp/x"],
    ["a traversal", "../../etc/passwd"],
    ["a ref name", "refs/heads/main"],
    ["an abbreviated sha", "3f9a2b1"],
    ["a sha one character short", "a".repeat(39)],
    ["a sha with a trailing argument", `${SHA} --upload-pack=x`],
  ];

  for (const [what, commitSha] of hostile) {
    const res = await deploy({ commitSha });
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  // --- the mode that does not touch git ------------------------------------
  //
  // A re-build rebuilds the files already on disk. Honouring a commit here would
  // mean building whatever is checked out while the panel reported the commit
  // that was asked for, so it is refused rather than ignored.
  let res = await deploy({ mode: "rebuild", commitSha: SHA });
  r.check(
    "a re-build cannot carry a commit",
    res.status === 400 && /re-build/i.test(res.body.error ?? ""),
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // --- a project with no GitHub source has no commit to choose -------------
  res = await deploy({ commitSha: SHA });
  r.check(
    "a project with no repository is told so, not sent to git",
    res.status === 400 && /GitHub/i.test(res.body.error ?? ""),
    `${res.status} ${JSON.stringify(res.body)}`
  );

  res = await api.call(`/api/projects/${projectId}`);
  r.check(
    "a refused commit deploy leaves no pin behind",
    res.body.pinned_sha === null || res.body.pinned_sha === undefined,
    String(res.body.pinned_sha)
  );

  // --- the pin, on a project that does have a repository -------------------
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      sourceType: "github",
      sourceUrl: "https://github.com/runpanel-test/does-not-exist",
      sourceBranch: "main",
    }),
  });

  res = await deploy({ commitSha: SHA });
  r.check("a commit deploy is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  let project = (await api.call(`/api/projects/${projectId}`)).body;
  r.check("the project is pinned to the commit", project.pinned_sha === SHA, String(project.pinned_sha));
  r.check("the pin is dated", Boolean(project.pinned_at), String(project.pinned_at));

  // The intention is written onto the deployment row before anything runs, so
  // the history says what was attempted even when the checkout never gets far
  // enough to read a commit message.
  await sleep(8_000);
  const history = (await api.call(`/api/projects/${projectId}/logs`)).body;
  r.check(
    "the history records the commit that was asked for",
    Array.isArray(history) && history.some((d) => d.commit_sha === SHA),
    JSON.stringify((history ?? []).map((d) => d.commit_sha))
  );

  // --- auto-deploy is suspended while pinned -------------------------------
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ autoDeploy: true }),
  });

  const status = (await api.call(`/api/projects/${projectId}/webhook`)).body;
  r.check(
    "the auto-deploy section reports the suspension",
    Array.isArray(status?.checks) && status.checks.some((c) => c.id === "pinned"),
    JSON.stringify((status?.checks ?? []).map((c) => c.id))
  );

  // Under polling the panel deliberately stops writing `poll_checked_at` for a
  // pinned project, so the timestamp goes stale by design. Saying "il pannello
  // potrebbe essere stato fermo" about that would blame an outage for something
  // the operator asked for.
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ deployTrigger: "poll" }),
  });
  const polling = (await api.call(`/api/projects/${projectId}/webhook`)).body;
  const pollCheck = (polling?.checks ?? []).find((c) => c.id === "poll");
  r.check(
    "polling reports itself suspended rather than stale",
    pollCheck?.tone === "neutral" && /sospes/i.test(pollCheck?.title ?? ""),
    JSON.stringify(pollCheck)
  );

  // --- releasing ------------------------------------------------------------
  res = await api.call(`/api/projects/${projectId}/pin`, {
    method: "POST",
    body: JSON.stringify({ action: "release" }),
  });
  r.check("the pin can be released", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  project = (await api.call(`/api/projects/${projectId}`)).body;
  r.check("releasing clears the pin", project.pinned_sha === null, String(project.pinned_sha));
  r.check(
    "releasing forgets the commit the poller had seen",
    project.poll_sha === null,
    String(project.poll_sha)
  );

  res = await api.call(`/api/projects/${projectId}/pin`, {
    method: "POST",
    body: JSON.stringify({ action: "pin", commitSha: SHA }),
  });
  r.check("the pin route takes only its one action", res.status === 400, String(res.status));

  // --- the commit list ------------------------------------------------------
  //
  // `useResource` throws away the body of any non-2xx, so every state the picker
  // has to render arrives as a 200 carrying the sentence to show. A 404 with a
  // careful explanation inside is an explanation nobody reads.
  const zip = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Commit Suite Zip" }),
  });
  const zipId = zip.body.id;

  res = await api.call(`/api/projects/${zipId}/commits`);
  r.check(
    "a project with no repository answers 200 so the reason can be rendered",
    res.status === 200 && res.body.available === false && res.body.reason === "no-repo",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  r.check(
    "and the reason comes with something to show",
    typeof res.body.message === "string" && res.body.message.length > 0,
    String(res.body.message)
  );

  for (const [what, query] of [
    ["a branch that walks out of the path", "branch=..%2F.."],
    ["a branch that looks like an option", "branch=-x"],
    ["a page size past the cap", "perPage=999"],
  ]) {
    res = await api.call(`/api/projects/${projectId}/commits?${query}`);
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  res = await api.call(`/api/projects/00000000000/commits`);
  r.check("an unknown project is a 404", res.status === 404, String(res.status));

  await api.call(`/api/projects/${zipId}`, { method: "DELETE" });
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
