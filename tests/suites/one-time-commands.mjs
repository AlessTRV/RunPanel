import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The queue of one-time commands, as a route — nothing is deployed here.
 *
 * The two properties worth pinning are the ones that are not obvious from the
 * shape of the endpoint. First, a save is a REPLACE that nonetheless preserves
 * a row's identity: sending a row back with its `id` has to keep the attempt
 * count and the note left by a failure, or fixing a typo in a command that
 * already failed once would hand back a row that looks untried. Second, a phase
 * that does not exist for the project's runtime is refused at the door rather
 * than dropped at deploy time, because a row pinned to a phase nothing will
 * ever reach sits in the queue forever.
 */
export const meta = { name: "one-time-commands", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("one-time-commands");
  const api = client(base);

  // --- auth ------------------------------------------------------------------
  const unauth = await fetch(`${base}/api/projects/whatever/one-time-commands`);
  r.check("the queue requires auth", unauth.status === 401, String(unauth.status));

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "one-time-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "One Time Suite" }),
  });
  const projectId = created.body?.id;
  r.check("project created", created.status === 201, JSON.stringify(created.body));

  const url = `/api/projects/${projectId}/one-time-commands`;
  const put = (commands) => api.call(url, { method: "PUT", body: JSON.stringify({ commands }) });

  // --- empty to begin with ---------------------------------------------------
  let res = await api.call(url);
  r.check(
    "a new project has an empty queue and no history",
    res.status === 200 && res.body.queued.length === 0 && res.body.history.length === 0,
    JSON.stringify(res.body)
  );

  res = await api.call(`/api/projects/${projectId}`);
  r.check(
    "the project payload carries the queue",
    Array.isArray(res.body.oneTimeCommands) && res.body.oneTimeCommands.length === 0,
    JSON.stringify(res.body.oneTimeCommands)
  );

  // --- what is refused -------------------------------------------------------
  for (const [what, commands] of [
    ["an unknown phase", [{ phase: "whenever", command: "true", continueOnError: false }]],
    ["an empty command", [{ phase: "post-build", command: "   ", continueOnError: false }]],
    [
      "a command past the cap",
      [{ phase: "post-build", command: "x".repeat(4001), continueOnError: false }],
    ],
    ["a missing flag", [{ phase: "post-build", command: "true" }]],
    [
      "more than fifty rows",
      Array.from({ length: 51 }, () => ({ phase: "post-build", command: "true", continueOnError: false })),
    ],
  ]) {
    const bad = await put(commands);
    r.check(`${what} is refused`, bad.status === 400, `${bad.status} ${JSON.stringify(bad.body).slice(0, 120)}`);
  }

  // --- saving ----------------------------------------------------------------
  res = await put([
    { phase: "post-source", command: "echo uno", label: "primo", continueOnError: false },
    { phase: "post-build", command: "echo due", continueOnError: true },
  ]);
  r.check("two commands saved", res.status === 200 && res.body.queued.length === 2, JSON.stringify(res.body).slice(0, 200));

  const [first, second] = res.body.queued;
  r.check("order is preserved", first.phase === "post-source" && second.phase === "post-build", `${first.phase}/${second.phase}`);
  r.check("the label is kept", first.label === "primo", String(first.label));
  r.check("a missing label is null, not an empty string", second.label === null, JSON.stringify(second.label));
  r.check("the continue flag survives the round trip", first.continueOnError === false && second.continueOnError === true, "flags");
  r.check("a fresh row has no attempts", first.attempts === 0 && second.attempts === 0, "attempts");
  r.check("nothing is blocked on a native project", !first.blockedReason && !second.blockedReason, String(first.blockedReason));

  // --- editing keeps identity -----------------------------------------------
  res = await put([
    { id: first.id, phase: "post-source", command: "echo uno-corretto", label: "primo", continueOnError: false },
  ]);
  r.check(
    "an edited row keeps its id and the other is dropped",
    res.status === 200 &&
      res.body.queued.length === 1 &&
      res.body.queued[0].id === first.id &&
      res.body.queued[0].command === "echo uno-corretto",
    JSON.stringify(res.body.queued)
  );

  // A row sent without an id is a new row, even with identical contents.
  res = await put([
    { id: first.id, phase: "post-source", command: "echo uno-corretto", continueOnError: false },
    { phase: "pre-install", command: "echo tre", continueOnError: false },
  ]);
  r.check(
    "a row with no id is inserted",
    res.status === 200 && res.body.queued.length === 2 && res.body.queued[1].id !== first.id,
    JSON.stringify(res.body.queued.map((c) => c.id))
  );

  // --- the runtime decides which phases exist --------------------------------
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ runtimeType: "docker" }),
  });

  const refused = await put([{ phase: "pre-install", command: "echo tre", continueOnError: false }]);
  r.check(
    "an install phase is refused on a Docker project",
    refused.status === 400 && refused.body.code === "phase-unavailable",
    `${refused.status} ${JSON.stringify(refused.body).slice(0, 160)}`
  );

  // The row queued while the project was native is still there, and says why it
  // cannot run — rather than disappearing, or silently never being reached.
  res = await api.call(url);
  const stranded = res.body.queued.find((command) => command.phase === "pre-install");
  r.check(
    "a row stranded by a runtime change explains itself",
    Boolean(stranded?.blockedReason),
    JSON.stringify(stranded)
  );

  /*
    A stranded row must not hold the whole section hostage.

    The editor sends the entire queue on every save, so checking every row for
    phase availability meant one row left behind by a runtime change rejected
    every later edit with a 400 about a command the operator was not touching —
    while the section told them the row would simply stay in the queue. Both
    cannot be true. An unchanged stored row passes; a new or edited one on an
    unavailable phase still does not.
  */
  res = await api.call(url);
  const carried = res.body.queued.map((command) => ({
    id: command.id,
    phase: command.phase,
    command: command.command,
    label: command.label,
    continueOnError: command.continueOnError,
  }));

  res = await put([
    ...carried,
    { phase: "post-build", command: "echo nuovo", continueOnError: false },
  ]);
  r.check(
    "a stranded row does not block saving the rest",
    res.status === 200 && res.body.queued.length === carried.length + 1,
    `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
  );

  const stillStranded = res.body.queued.find((command) => command.phase === "pre-install");
  r.check("and it is still there, still flagged", Boolean(stillStranded?.blockedReason), JSON.stringify(stillStranded));

  // Editing that same row onto the unavailable phase is still refused.
  const edited = await put(
    res.body.queued.map((command) =>
      command.phase === "pre-install"
        ? { id: command.id, phase: "pre-install", command: "echo cambiato", continueOnError: false }
        : { id: command.id, phase: command.phase, command: command.command, continueOnError: command.continueOnError }
    )
  );
  r.check(
    "but editing it on that phase is refused",
    edited.status === 400 && edited.body.code === "phase-unavailable",
    `${edited.status} ${JSON.stringify(edited.body).slice(0, 160)}`
  );

  // Back to native, and the block goes away on its own.
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ runtimeType: "node" }),
  });
  res = await api.call(url);
  r.check(
    "the block lifts when the runtime goes back",
    res.body.queued.every((command) => command.blockedReason === null),
    JSON.stringify(res.body.queued.map((c) => c.blockedReason))
  );

  // --- clearing --------------------------------------------------------------
  res = await api.call(url, { method: "DELETE" });
  r.check("clearing an empty history is not an error", res.status === 200 && res.body.removed === 0, JSON.stringify(res.body));

  res = await api.call(url);
  r.check("clearing the history leaves the queue alone", res.body.queued.length === 3, String(res.body.queued.length));

  res = await put([]);
  r.check("an empty list empties the queue", res.status === 200 && res.body.queued.length === 0, JSON.stringify(res.body));

  // --- cascade ---------------------------------------------------------------
  await put([{ phase: "post-build", command: "echo bye", continueOnError: false }]);
  const removed = await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("project deleted with a queue attached", removed.status === 200, `${removed.status} ${JSON.stringify(removed.body).slice(0, 160)}`);

  const gone = await api.call(url);
  r.check("the queue goes with the project", gone.status === 404, String(gone.status));

  return r.result();
}
