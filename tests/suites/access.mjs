import net from "node:net";
import { client, createReporter, docker, SETUP_TOKEN } from "../harness.mjs";

/**
 * Restricting a database's port — over HTTP, against a real container.
 *
 * `access-rules-unit` proves the arithmetic and `access-gate` proves the
 * socket. What is left, and what neither can reach, is the sequence: the
 * container has to be recreated onto loopback and the gate has to bind the
 * public port afterwards, in that order, without losing the volume, the
 * project network or the status the service was in.
 *
 * Needs Docker for the same reason `service-link` does: the part most likely to
 * break is the publish spec of an actual container, and a faked one would not
 * be testing it.
 */
export const meta = { name: "access", needsDocker: true, drivers: ["sqlite"] };

const PORT = 55498;

/** Does anything answer on this address and port? */
function reachable(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), timeout);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

export async function run({ base }) {
  const r = createReporter("access");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "access-suite-pw" }),
  });

  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Access Suite" }),
  });
  const projectId = project.body.id;

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "guarded",
      type: "postgresql",
      version: "16",
      port: PORT,
      projectId,
      credentials: { user: "runpanel", password: "access-pw", database: "guarded_db" },
    }),
  });
  r.check("a database is created", created.status === 201,
    `${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);
  if (created.status !== 201) return r.result();

  const serviceId = created.body.id;
  const containerName = created.body.container_name;

  try {
    // --- it starts open, exactly as before -----------------------------------
    {
      r.check("a new service is open", created.body.access_mode === "open", String(created.body.access_mode));
      r.check("with no moved port", created.body.access_port === null, String(created.body.access_port));

      const ports = docker("inspect", "-f", "{{json .HostConfig.PortBindings}}", containerName);
      // No HostIp is a bind on every interface — the behaviour this feature
      // exists to make optional.
      r.check("published on every interface", !ports.includes("127.0.0.1"), ports.trim());
    }

    // --- a bad rule is refused before anything moves -------------------------
    {
      const bad = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "restricted", allow: ["not-a-network"] } }),
      });
      r.check("a malformed rule is a 400", bad.status === 400, String(bad.status));

      const everything = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "restricted", allow: ["0.0.0.0/0"] } }),
      });
      r.check("so is a /0", everything.status === 400, String(everything.status));

      const after = await api.call(`/api/services/${serviceId}`);
      r.check("and nothing changed", after.body.access.mode === "open", String(after.body.access?.mode));
    }

    // --- turning it on -------------------------------------------------------
    {
      const on = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "restricted", allow: ["192.168.1.0/24"] } }),
      });
      r.check("the restriction is accepted", on.status === 200,
        `${on.status} ${JSON.stringify(on.body).slice(0, 160)}`);
      r.check("the row says restricted", on.body.access?.mode === "restricted", String(on.body.access?.mode));
      r.check("a loopback port was allocated", typeof on.body.access?.port === "number", String(on.body.access?.port));
      r.check("and the gate is up", on.body.gate?.running === true, JSON.stringify(on.body.gate));
      r.check("on the port clients already know", on.body.gate?.publicPort === PORT, String(on.body.gate?.publicPort));

      const ports = docker("inspect", "-f", "{{json .HostConfig.PortBindings}}", containerName);
      r.check("the container now publishes on loopback only", ports.includes("127.0.0.1"), ports.trim());
      r.check("and no longer on the public port", !ports.includes(`"${PORT}"`), ports.trim());

      // The volume is why recreating the container is safe; if it went, the
      // database went with it.
      const mounts = docker("inspect", "-f", "{{json .Mounts}}", containerName);
      r.check("the data volume survived the recreate", mounts.includes("runpanel-pg-"), mounts.slice(0, 140));

      // The container is recreated, so its membership of the project network
      // has to be re-established or the app loses its database.
      const networks = docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", containerName);
      r.check("and so did the project network", networks.includes("runpanel-net-"), networks.slice(0, 160));

      r.check("loopback still reaches it through the gate", await reachable("127.0.0.1", PORT));
    }

    // --- editing the list does not disturb the binding -----------------------
    {
      const before = await api.call(`/api/services/${serviceId}`);
      const movedPort = before.body.access.port;

      const edit = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "restricted", allow: ["192.168.1.0/24", "10.0.0.0/8"] } }),
      });
      r.check("the list can be edited", edit.status === 200, String(edit.status));
      r.check("both rules are stored", edit.body.access.allow.length === 2, JSON.stringify(edit.body.access.allow));
      // Re-allocating would mean recreating the container for a change that
      // only affects the next connection.
      r.check("the moved port is unchanged", edit.body.access.port === movedPort, String(edit.body.access.port));
      r.check("and the gate is still up", edit.body.gate.running === true);
    }

    // --- the link keeps working ----------------------------------------------
    {
      // An app on the project network reaches the container by name and by the
      // port inside it, so it never touches the gate. This is the promise the
      // interface makes, and it has to be true.
      const detail = await api.call(`/api/services/${serviceId}`);
      r.check("the injected variable is unchanged", detail.body.envKey === "DATABASE_URL", String(detail.body.envKey));
      r.check("and still injected", detail.body.injectEnv === true, String(detail.body.injectEnv));
      r.check("the container port is still the internal one", detail.body.internalPort === 5432,
        String(detail.body.internalPort));
    }

    // --- a stopped service stays stopped -------------------------------------
    {
      await api.call(`/api/services/${serviceId}/control`, {
        method: "POST",
        body: JSON.stringify({ action: "stop" }),
      });

      const off = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "open", allow: [] } }),
      });
      r.check("the restriction can be lifted while stopped", off.status === 200,
        `${off.status} ${JSON.stringify(off.body).slice(0, 160)}`);
      // Recreating starts the container; a service the operator had stopped has
      // to end up stopped again.
      r.check("and the service is still stopped", off.body.status === "stopped", String(off.body.status));
      r.check("the gate is down", off.body.gate.running === false, JSON.stringify(off.body.gate));
      r.check("and the moved port is cleared", off.body.access.port === null, String(off.body.access.port));

      const ports = docker("inspect", "-f", "{{json .HostConfig.PortBindings}}", containerName);
      r.check("the container publishes on every interface again", !ports.includes("127.0.0.1"), ports.trim());
    }

    // --- and it is not open to anyone without a session ----------------------
    {
      const stranger = await client(base).call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ access: { mode: "restricted", allow: [] } }),
      });
      r.check("PATCH requires a session", stranger.status === 401, String(stranger.status));
    }
  } finally {
    await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
    await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  }

  return r.result();
}
