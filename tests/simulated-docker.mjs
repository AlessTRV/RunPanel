/**
 * A Docker daemon in memory, behind the `DockerCli` interface that
 * `services/backup/volume-ops.ts` is written against.
 *
 * It keeps just enough state to answer the questions the backup and restore
 * sequences ask — which volumes exist with which labels, which containers mount
 * them and in what state — and records every command, together with the state
 * of the volume's users at the moment a copy or a write happened. That is what
 * lets a suite assert "the stack was stopped while its volume was overwritten"
 * without a daemon.
 *
 * Deliberately sloppier than a real engine where it matters: label filters
 * match by prefix and `volume=` by substring. The code under test is supposed
 * to check ownership itself, whole, and a faithful simulator could not tell
 * whether it does.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ACTIVE = new Set(["running", "paused", "restarting"]);

function valuesOf(args, flag) {
  const out = [];
  args.forEach((arg, index) => {
    if (arg === flag && index + 1 < args.length) out.push(args[index + 1]);
  });
  return out;
}

function labelMatch(labels, filter) {
  const body = filter.replace(/^label=/, "");
  const eq = body.indexOf("=");
  const key = eq < 0 ? body : body.slice(0, eq);
  const value = eq < 0 ? null : body.slice(eq + 1);
  if (!(key in labels)) return false;
  return value === null || labels[key].startsWith(value);
}

function renderContainer(format, c) {
  const mounts = c.mounts.map((m) => `${m.name}=${m.rw}`).join(";");
  const out = format
    .replace(
      '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}={{.RW}};{{end}}{{end}}',
      mounts ? `${mounts};` : ""
    )
    .replace(/\{\{with index \.Config\.Labels "([^"]+)"\}\}\{\{\.\}\}\{\{end\}\}/g, (_, key) => c.labels[key] ?? "")
    .replace("{{.Id}}", c.id)
    .replace("{{.Name}}", `/${c.name}`)
    .replace("{{.State.Status}}", c.state);
  if (out.includes("{{")) throw new Error(`simulated docker: unsupported inspect format ${format}`);
  return out;
}

function renderVolume(format, v) {
  const out = format
    .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key) => v.labels[key] ?? "")
    .replace("{{.Name}}", v.name);
  if (out.includes("{{")) throw new Error(`simulated docker: unsupported volume format ${format}`);
  return out;
}

export class SimulatedDockerError extends Error {}

/**
 * @param {object} init
 * @param {{ name: string, labels?: Record<string,string> }[]} [init.volumes]
 * @param {{ id: string, name: string, state?: string, labels?: Record<string,string>, mounts?: { name: string, rw: boolean }[] }[]} [init.containers]
 * @param {Record<string, (args: string[]) => string | void>} [init.hooks] per-verb overrides: throw to fail, return stdout
 */
export function simulatedDocker({ volumes = [], containers = [], hooks = {} } = {}) {
  const state = {
    volumes: volumes.map((v) => ({ labels: {}, ...v })),
    containers: containers.map((c) => ({ state: "running", labels: {}, mounts: [], ...c })),
  };
  /** @type {{ args: string[], users?: { name: string, state: string }[] }[]} */
  const calls = [];

  const find = (ref) => state.containers.find((c) => c.id === ref || c.name === ref);
  const usersOf = (volume) =>
    state.containers
      .filter((c) => c.mounts.some((m) => m.name === volume))
      .map((c) => ({ name: c.name, state: c.state, rw: c.mounts.find((m) => m.name === volume).rw }));

  const volumeArg = (args) => {
    const spec = valuesOf(args, "-v")[0] ?? "";
    return spec.split(":")[0];
  };

  function transition(ref, from, to, verb) {
    const container = find(ref);
    if (!container) throw new SimulatedDockerError(`Error: No such container: ${ref}`);
    if (from && !from.includes(container.state)) {
      throw new SimulatedDockerError(`Error response from daemon: cannot ${verb} ${ref}: container is ${container.state}`);
    }
    container.state = to;
  }

  function respond(args) {
    const verb = args[0] === "volume" ? `volume ${args[1]}` : args[0];
    if (hooks[verb]) {
      const out = hooks[verb](args, state);
      if (typeof out === "string") return out;
    }

    switch (verb) {
      case "volume ls": {
        const filters = valuesOf(args, "--filter");
        const format = valuesOf(args, "--format")[0] ?? "{{.Name}}";
        return state.volumes
          .filter((v) => filters.every((f) => labelMatch(v.labels, f)))
          .map((v) => renderVolume(format, v))
          .join("\n");
      }
      case "ps": {
        const all = args.includes("-a");
        const filters = valuesOf(args, "--filter");
        return state.containers
          .filter((c) => all || ACTIVE.has(c.state))
          .filter((c) =>
            filters.every((f) =>
              f.startsWith("volume=")
                ? c.mounts.some((m) => m.name.includes(f.slice("volume=".length)))
                : labelMatch(c.labels, f)
            )
          )
          .map((c) => c.id)
          .join("\n");
      }
      case "inspect": {
        const format = valuesOf(args, "--format")[0];
        const refs = args.slice(args.indexOf(format) + 1);
        return refs
          .map((ref) => {
            const container = find(ref);
            if (!container) throw new SimulatedDockerError(`Error: No such object: ${ref}`);
            return renderContainer(format, container);
          })
          .join("\n");
      }
      case "pause":
        for (const ref of args.slice(1)) transition(ref, ["running"], "paused", "pause");
        return "";
      case "unpause":
        for (const ref of args.slice(1)) transition(ref, ["paused"], "running", "unpause");
        return "";
      case "stop":
        for (const ref of args.slice(1).filter((a) => !a.startsWith("-"))) transition(ref, null, "exited", "stop");
        return "";
      case "start":
        for (const ref of args.slice(1)) transition(ref, null, "running", "start");
        return "";
      case "exec":
        return "";
      case "run":
        return "";
      default:
        throw new SimulatedDockerError(`simulated docker: unexpected command docker ${args.join(" ")}`);
    }
  }

  const cli = {
    async run(args) {
      calls.push({ args });
      return { stdout: respond(args), stderr: "" };
    },

    async toFile(args, destination, opts) {
      const volume = volumeArg(args);
      calls.push({ args, users: usersOf(volume), compress: opts.compress });
      if (hooks.toFile) hooks.toFile(args, state);
      const raw = Buffer.from(`tar of ${volume}\n`);
      const body = opts.compress ? zlib.gzipSync(raw) : raw;
      fs.writeFileSync(destination, body);
      return { bytes: body.length, rawBytes: raw.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
    },

    async fromFile(args, source, opts) {
      const volume = volumeArg(args);
      calls.push({ args, users: usersOf(volume), decompress: opts.decompress, source });
      if (hooks.fromFile) hooks.fromFile(args, state);
    },
  };

  return {
    cli,
    calls,
    state,
    container: find,
    /** Commands that delete or kill something. None of these flows may issue one. */
    destructive: () =>
      calls.filter(({ args }) =>
        ["rm", "rmi", "kill"].includes(args[0]) ||
        (args[0] === "volume" && ["rm", "prune"].includes(args[1])) ||
        args.includes("prune") ||
        args.includes("down")
      ),
    verbs: () => calls.map(({ args }) => (args[0] === "volume" ? `volume ${args[1]}` : args[0])),
  };
}
