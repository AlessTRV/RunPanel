import { client, createReporter, docker, SETUP_TOKEN } from "../harness.mjs";

/**
 * Something stops without the panel being told.
 *
 * The status column is written when RunPanel starts or stops something, so it
 * records the last command the panel issued rather than the state of the
 * machine. Everything that stops another way — a reboot, an OOM kill, a
 * `docker stop` from a shell, the panel itself going down and taking its
 * children with it — used to leave the row saying "running" for good, because
 * nothing ever came back to ask.
 *
 * A container stopped behind the panel's back is that case, reproduced exactly:
 * the panel is never told, and the only way it can find out is by looking.
 * A project goes through the same sweep with the same rule — see `status-unit`
 * for the rule itself, which is where the states it must not overwrite are
 * checked.
 *
 * The sweep is driven here through the autostart reconciler, which runs one at
 * the end of its pass: a boot that brings everything back has to leave the
 * column agreeing with it.
 */
export const meta = {
  name: "status-sweep",
  needsDocker: true,
  drivers: ["sqlite"],
  // The sweep also runs on a timer. Turning the background timers off is what
  // makes "one sweep" mean one sweep here — with them on, an assertion about
  // the first sighting would depend on whether a tick landed between two lines
  // of this file.
  env: { RUNPANEL_DISABLE_SCHEDULERS: "1" },
};

/** Outside every range Windows reserves for Hyper-V — see `netsh ... excludedportrange`. */
const PORT = 47311;

export async function run({ base }) {
  const r = createReporter("status-sweep");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "status-sweep-pw" }),
  });

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "statuswatch",
      type: "redis",
      version: "7",
      port: PORT,
      credentials: { password: "sweep-pw" },
    }),
  });

  const service = created.body;
  r.check("the service was provisioned", created.status === 201, JSON.stringify(created.body));
  if (created.status !== 201) return r.result();

  const container = service.container_name;
  const statusOf = async () => {
    const list = await api.call("/api/services");
    return (list.body ?? []).find((s) => s.id === service.id)?.status;
  };

  r.check("it starts out running", (await statusOf()) === "running", await statusOf());

  // Autostart off, or the reconciler would start the container back up before
  // the sweep at the end of its pass ever looked at it — which is the correct
  // behaviour at a real boot and the wrong thing to be testing here.
  const off = await api.call("/api/autostart", {
    method: "PUT",
    body: JSON.stringify({ entries: [{ kind: "service", id: service.id, autostart: false }] }),
  });
  r.check("autostart can be turned off for it", off.status === 200, JSON.stringify(off.body));

  const sweep = () =>
    api.call("/api/autostart/reconcile", {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });

  // --- stopped behind the panel's back --------------------------------------
  docker("stop", "-t", "5", container);
  r.check(
    "the container really is down",
    !docker("ps", "--format", "{{.Names}}").split("\n").includes(container),
    docker("ps", "--format", "{{.Names}}")
  );
  r.check("but the panel still says running", (await statusOf()) === "running", await statusOf());

  // One reading is not enough to write a row down: an empty `pm2 jlist` and a
  // Docker that is still restarting its own containers after a reboot both look
  // exactly like this, and acting on either would paint the panel red and undo
  // it a sweep later.
  await sweep();
  r.check(
    "one sweep is not enough to call it stopped",
    (await statusOf()) === "running",
    await statusOf()
  );

  await sweep();
  r.check("a second, agreeing sweep corrects it", (await statusOf()) === "stopped", await statusOf());

  // --- and back up ----------------------------------------------------------
  //
  // No confirmation in this direction: a driver reporting a container as up has
  // just seen it. This is what makes a boot where autostart brought everything
  // back end with a panel that agrees.
  docker("start", container);
  await sweep();
  r.check(
    "coming back up is written on the first sweep",
    (await statusOf()) === "running",
    await statusOf()
  );

  await api.call(`/api/services/${service.id}`, { method: "DELETE" });
  return r.result();
}
