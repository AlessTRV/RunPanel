import { client, createReporter, docker, SETUP_TOKEN } from "../harness.mjs";

/**
 * A restart on a schedule, end to end, on a service.
 *
 * Driven by the real scheduler: this suite is the one that turns the panel's
 * timers back on (`RUNPANEL_DISABLE_SCHEDULERS` unset), pins the schedule to
 * every minute and waits for it. Slow on purpose — three schedule cycles, a
 * couple of minutes each way — because the thing most likely to break is the
 * tick itself, and a test that called the decision function directly would
 * never notice a timer that no longer fires.
 *
 * A service rather than a project because a project restart needs a
 * successful deploy behind it — a Docker build — and the scheduler treats the
 * two the same way.
 */
export const meta = {
  name: "scheduled-restart",
  needsDocker: true,
  drivers: ["sqlite"],
  env: { RUNPANEL_DISABLE_SCHEDULERS: "" },
};

const PORT = 55712;
/** A minute for the schedule, half a minute for the tick, and slack. */
const CYCLE_MS = 150_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ base }) {
  const r = createReporter("scheduled-restart");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "sched-suite-pw" }),
  });

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "sched",
      type: "redis",
      version: "7",
      port: PORT,
      credentials: { user: "", password: "sched-pw", database: "" },
    }),
  });
  r.check("a service is created", created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);
  if (created.status !== 201) return r.result();

  const id = created.body.id;
  const container = created.body.container_name;
  const row = async () => (await api.call(`/api/services/${id}`)).body;
  const startedAt = () => docker("inspect", container, "--format", "{{.State.StartedAt}}");
  const isUp = () => docker("ps", "--format", "{{.Names}}").split("\n").includes(container);

  /**
   * Wait for the schedule to fire once more than it already has, and for that
   * occurrence to finish: the claim writes "In corso" before the restart runs
   * and the outcome replaces it after.
   */
  async function waitForRun(previousLastAt) {
    const deadline = Date.now() + CYCLE_MS;
    while (Date.now() < deadline) {
      const current = await row();
      const fired = current.restart_last_at && current.restart_last_at !== previousLastAt;
      if (fired && current.restart_last_result && current.restart_last_result !== "In corso") return current;
      await sleep(3_000);
    }
    return await row();
  }

  try {
    // --- the panel's time zone decides the wall clock ---------------------------
    // A nightly at 04:00 means 04:00 where the operator is, and moving the
    // panel to another zone has to move the pending occurrence with it — not
    // leave it at the old instant until it has fired once.
    const settings = (await api.call("/api/settings")).body;
    r.check(
      "a panel that never saved a zone says so, instead of implying the browser's",
      settings.timezone_effective === "UTC" && !settings.timezone,
      JSON.stringify({ timezone: settings.timezone, effective: settings.timezone_effective })
    );

    const nightly = await api.call(`/api/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ restartCron: "0 4 * * *" }),
    });
    r.check(
      "in UTC a 04:00 schedule lands on 04:00Z",
      new Date(nightly.body.restart_next_at).getUTCHours() === 4,
      String(nightly.body.restart_next_at)
    );

    const badZone = await api.call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ preferences: { timezone: "Europe/Nowhere" } }),
    });
    r.check("an unknown zone is refused rather than silently becoming UTC", badZone.status === 400, String(badZone.status));

    const tokyo = await api.call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ preferences: { timezone: "Asia/Tokyo" } }),
    });
    r.check("a real zone is accepted", tokyo.status === 200, `${tokyo.status} ${JSON.stringify(tokyo.body)}`);
    const moved = (await row()).restart_next_at;
    // 04:00 in Tokyo (UTC+9, no daylight saving) is 19:00Z the day before.
    r.check(
      "and the pending occurrence moves to 04:00 in that zone",
      new Date(moved).getUTCHours() === 19,
      String(moved)
    );

    await api.call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ preferences: { timezone: "UTC" } }),
    });

    // --- setting the schedule --------------------------------------------------
    const bad = await api.call(`/api/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ restartCron: "every day" }),
    });
    r.check("a bad expression is refused", bad.status === 400, String(bad.status));

    const before = startedAt();
    const set = await api.call(`/api/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ restartCron: "* * * * *" }),
    });
    r.check("a schedule is accepted", set.status === 200, `${set.status} ${JSON.stringify(set.body).slice(0, 140)}`);
    r.check("and stored", set.body.restart_cron === "* * * * *", String(set.body.restart_cron));
    const next = Date.parse(set.body.restart_next_at ?? "");
    r.check(
      "with the next occurrence already computed, within the minute",
      Number.isFinite(next) && next > Date.now() - 1_000 && next <= Date.now() + 61_000,
      String(set.body.restart_next_at)
    );

    // --- it fires -------------------------------------------------------------
    let current = await waitForRun(null);
    r.check("the scheduler restarted it", current.restart_last_result === "Riavviato", String(current.restart_last_result));
    r.check("and the container really was restarted", startedAt() !== before, `${before} → ${startedAt()}`);
    r.check("and it is still running", current.status === "running" && isUp(), current.status);
    r.check(
      "the next occurrence moved forward",
      Date.parse(current.restart_next_at) > Date.parse(current.restart_last_at),
      `${current.restart_last_at} → ${current.restart_next_at}`
    );

    // --- stopped on purpose is left alone --------------------------------------
    await api.call(`/api/services/${id}/control`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
    r.check("stopped by hand", (await row()).status === "stopped" && !isUp());

    current = await waitForRun(current.restart_last_at);
    r.check("the schedule skips it", current.restart_last_result === "Saltato: fermato a mano", String(current.restart_last_result));
    r.check("and it stays down", !isUp() && current.status === "stopped", current.status);

    // --- crashed gets one attempt ---------------------------------------------
    await api.call(`/api/services/${id}/control`, { method: "POST", body: JSON.stringify({ action: "start" }) });
    r.check("started again", (await row()).status === "running" && isUp());

    // The reconciler is what notices a crash. Autostart off first, or it would
    // bring the container back before the sweep looked at it.
    await api.call("/api/autostart", {
      method: "PUT",
      body: JSON.stringify({ entries: [{ kind: "service", id, autostart: false }] }),
    });
    docker("stop", "-t", "5", container);
    const sweep = () =>
      api.call("/api/autostart/reconcile", { method: "POST", body: JSON.stringify({ dryRun: false }) });
    await sweep();
    await sweep();
    current = await row();
    r.check("the sweep wrote it down as stopped", current.status === "stopped", current.status);
    r.check("and marked it as a crash, not a choice", typeof current.crashed_at === "string", String(current.crashed_at));

    current = await waitForRun(current.restart_last_at);
    r.check("the schedule tries once after a crash", current.restart_last_result === "Riavviato dopo un crash", String(current.restart_last_result));
    r.check("and the container is back", isUp() && current.status === "running", current.status);
    r.check("with the crash marker cleared", current.crashed_at === null, String(current.crashed_at));

    // --- switching it off -----------------------------------------------------
    const off = await api.call(`/api/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ restartCron: "" }),
    });
    r.check("an empty expression switches it off", off.status === 200 && off.body.restart_cron === "", JSON.stringify(off.body).slice(0, 120));
    r.check("and forgets the next occurrence", off.body.restart_next_at === null, String(off.body.restart_next_at));
  } finally {
    await api.call(`/api/services/${id}?deleteData=true`, { method: "DELETE" });
  }

  return r.result();
}
