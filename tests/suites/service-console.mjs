import { client, createReporter, docker, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Talking to a service, and the flags that decide whether the answer is
 * readable.
 *
 * `docker exec -i` with piped stdio cannot allocate a TTY, and every database
 * client changes behaviour when it does not have one — usually by switching to
 * a machine-readable mode that is unreadable to a person. The assertions below
 * are that behaviour, pinned: they fail if a flag is dropped, and dropping one
 * is the kind of change that looks harmless in a diff.
 *
 * Redis and Postgres only, on purpose: those two images are the ones a RunPanel
 * host already has, so the suite costs no pull. MySQL's `--table`/`--force` and
 * Mongo's `--shell` carry the same reasoning and are checked by hand — see the
 * per-engine table in `services/service-console.ts`.
 */
export const meta = { name: "service-console", needsDocker: true, drivers: ["sqlite"] };

/** Outside every range Windows reserves for Hyper-V — see `netsh ... excludedportrange`. */
const REDIS_PORT = 47320;
const PG_PORT = 47321;

/** Read one service's SSE stream into an array until `stop()` is called. */
function follow(base, api, serviceId) {
  const events = [];
  const controller = new AbortController();

  const reading = (async () => {
    const res = await fetch(`${base}/api/services/${serviceId}/stream`, {
      headers: { cookie: api.cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, contentType: "", cacheControl: "" };

    const meta = {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      cacheControl: res.headers.get("cache-control") ?? "",
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* a malformed frame should not stop the read */
          }
        }
      }
    } catch {
      /* aborted */
    }
    return meta;
  })();

  return { events, stop: () => controller.abort(), reading };
}

/** Everything the console has printed so far, as one string. */
const transcript = (events) =>
  events
    .filter((e) => e.type === "console:output")
    .map((e) => e.text)
    .join("");

async function waitFor(events, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(transcript(events), events)) return true;
    await sleep(250);
  }
  return false;
}

export async function run({ base }) {
  const r = createReporter("service-console");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "console-suite-pw" }),
  });

  // --- redis ----------------------------------------------------------------
  const redis = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "consoleredis",
      type: "redis",
      version: "7",
      port: REDIS_PORT,
      credentials: { password: "console-pw" },
    }),
  });
  r.check("redis provisioned", redis.status === 201, JSON.stringify(redis.body));
  if (redis.status !== 201) return r.result();

  const redisId = redis.body.id;
  const console_ = (body) =>
    api.call(`/api/services/${redisId}/console`, { method: "POST", body: JSON.stringify(body) });

  // --- the confirmation cannot be posted around -----------------------------
  //
  // The dialog is the UI half of one rule. This is the half that counts.
  let res = await console_({ action: "start", mode: "engine" });
  r.check(
    "a session without the acknowledgement is refused",
    res.status === 400,
    `${res.status} ${JSON.stringify(res.body)}`
  );

  res = await console_({ action: "start", mode: "logs" });
  r.check("the log is read-only, so it needs no acknowledgement", res.status === 200, String(res.status));
  await console_({ action: "stop" });

  res = await console_({ action: "start", mode: "chisso", confirmed: true });
  r.check("an unknown mode is refused", res.status === 400, String(res.status));

  res = await console_({ action: "input", input: "x\n" });
  r.check(
    "typing with no session open is reported, not an error",
    res.status === 200 && res.body.status === "closed",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // --- the stream -----------------------------------------------------------
  const stream = follow(base, api, redisId);
  await sleep(600);

  r.check(
    "a ready frame arrives before anything happens",
    stream.events.some((e) => e.type === "ready"),
    JSON.stringify(stream.events.slice(0, 2))
  );

  res = await console_({ action: "start", mode: "engine", confirmed: true });
  r.check("the engine console opens", res.status === 200, JSON.stringify(res.body));

  await console_({ action: "input", input: "PING\n" });
  r.check(
    "the engine answers",
    await waitFor(stream.events, (text) => /PONG/i.test(text)),
    transcript(stream.events)
  );

  // Without a TTY redis-cli picks raw output: no `1)` numbering, no quoting,
  // binary values printed as unescaped bytes into the SSE frame. `--no-raw` is
  // what puts the readable form back, and this is the assertion that says so.
  await console_({ action: "input", input: "RPUSH runpanel_console a b\n" });
  await console_({ action: "input", input: "LRANGE runpanel_console 0 -1\n" });
  r.check(
    "the list comes back numbered, not raw",
    await waitFor(stream.events, (text) => /1\)/.test(text)),
    transcript(stream.events)
  );

  // A console has to survive a typo: an error must print and leave the session
  // open for the next line.
  await console_({ action: "input", input: "NOPESUCHCOMMAND\n" });
  await console_({ action: "input", input: "PING\n" });
  r.check(
    "a bad command does not end the session",
    await waitFor(
      stream.events,
      (text) => (text.match(/PONG/gi) ?? []).length >= 2
    ),
    transcript(stream.events)
  );

  res = await console_({ action: "stop" });
  r.check("the session can be closed", res.status === 200, String(res.status));

  // --- a stopped service has nothing to exec into ---------------------------
  await api.call(`/api/services/${redisId}/control`, {
    method: "POST",
    body: JSON.stringify({ action: "stop" }),
  });
  res = await console_({ action: "start", mode: "engine", confirmed: true });
  r.check(
    "a stopped service says so instead of opening a session that dies",
    res.status === 409,
    `${res.status} ${JSON.stringify(res.body)}`
  );
  // The log of a container that is not running is exactly what one stares at to
  // find out why it is not running.
  res = await console_({ action: "start", mode: "logs" });
  r.check("but its log is still readable", res.status === 200, String(res.status));
  await console_({ action: "stop" });

  stream.stop();
  await stream.reading;

  // --- postgres: the aligned output psql keeps without a TTY ----------------
  const pg = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "consolepg",
      type: "postgresql",
      version: "16",
      port: PG_PORT,
      credentials: { user: "runpanel", password: "console-pg-pw", database: "primary_db" },
    }),
  });
  r.check("postgres provisioned", pg.status === 201, JSON.stringify(pg.body));

  if (pg.status === 201) {
    const pgId = pg.body.id;
    const container = pg.body.container_name;

    // The image restarts once after initdb, so "ready" has to be observed.
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (docker("exec", container, "pg_isready").includes("accepting connections")) {
        ready = true;
        break;
      }
      await sleep(1000);
    }
    r.check("postgres is accepting connections", ready);

    const pgStream = follow(base, api, pgId);
    await sleep(400);

    res = await api.call(`/api/services/${pgId}/console`, {
      method: "POST",
      body: JSON.stringify({ action: "start", mode: "engine", confirmed: true }),
    });
    r.check("the postgres console opens", res.status === 200, JSON.stringify(res.body));

    await api.call(`/api/services/${pgId}/console`, {
      method: "POST",
      body: JSON.stringify({ action: "input", input: "SELECT 1 AS uno;\n" }),
    });
    // Aligned output is psql's default and survives the missing TTY; the box
    // rule is what proves nothing switched it to unaligned.
    r.check(
      "the answer comes back as a table, not as a bare value",
      await waitFor(pgStream.events, (text) => /-----/.test(text) && /uno/.test(text)),
      transcript(pgStream.events)
    );

    // `--echo-queries` is what replaces the prompt psql cannot print.
    r.check(
      "the statement is echoed above its result",
      await waitFor(pgStream.events, (text) => /SELECT 1 AS uno;/.test(text)),
      transcript(pgStream.events)
    );

    // `ON_ERROR_STOP` is deliberately unset: a console must survive a typo.
    await api.call(`/api/services/${pgId}/console`, {
      method: "POST",
      body: JSON.stringify({ action: "input", input: "SELECT nope;\n" }),
    });
    await api.call(`/api/services/${pgId}/console`, {
      method: "POST",
      body: JSON.stringify({ action: "input", input: "SELECT 2 AS due;\n" }),
    });
    r.check(
      "an error leaves the session open",
      await waitFor(pgStream.events, (text) => /due/.test(text)),
      transcript(pgStream.events)
    );

    pgStream.stop();
    await pgStream.reading;
    await api.call(`/api/services/${pgId}?deleteData=true`, { method: "DELETE" });
  }

  await api.call(`/api/services/${redisId}?deleteData=true`, { method: "DELETE" });
  return r.result();
}
