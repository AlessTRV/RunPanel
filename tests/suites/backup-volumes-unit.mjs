import { createReporter } from "../harness.mjs";
import { simulatedDocker } from "../simulated-docker.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { gunzipSync as zlibGunzip } from "node:zlib";

/**
 * Backing up and restoring a project's volumes, against a simulated daemon.
 *
 * The case that was broken: a project on the Compose runtime was backed up
 * without any of its data. Compose refuses `--label` on `up`, so the volumes of
 * its stack carry only `com.docker.compose.project=runpanel-<slug>`, and the
 * backup only ever asked for RunPanel's own labels. The policy said "volumi",
 * the run said nothing, and no archive held a single byte of the database.
 *
 * The simulator is looser than a real engine on purpose — see its header — so
 * every ownership check here is one the code makes itself.
 */
export const meta = { name: "backup-volumes-unit", needsDocker: false, drivers: [], standalone: true };

const SLUG = "memebot";
const STACK = "runpanel-memebot";

export async function run({ repoRoot }) {
  const r = createReporter("backup-volumes-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  const ops = await load("services", "backup", "volume-ops.ts");
  const labels = await load("services", "docker", "labels.ts");

  const owner = {
    slug: SLUG,
    composeProject: STACK,
    runpanelFilters: labels.ownedFilters({ project: SLUG }),
    projectLabel: labels.LABEL_PROJECT,
  };

  const compose = (project, volume) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.volume": volume,
  });
  const runpanel = (project) => ({ "runpanel.managed": "true", "runpanel.project": project });
  const stackContainer = (id, service, mounts, state = "running") => ({
    id,
    name: `memebot-${service}`,
    state,
    labels: { "com.docker.compose.project": STACK, "com.docker.compose.service": service },
    mounts,
  });

  const log = [];
  const say = (line) => log.push(line);
  const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-volumes-"));

  try {
    // --- discovery ---------------------------------------------------------------
    {
      const docker = simulatedDocker({
        volumes: [
          { name: "runpanel-memebot_memebot-data", labels: compose(STACK, "memebot-data") },
          // A project whose name merely starts the same way.
          { name: "runpanel-memebot2_data", labels: compose("runpanel-memebot2", "data") },
          { name: "runpanel-postgres-memebot-db", labels: runpanel(SLUG) },
          { name: "runpanel-postgres-memebot2-db", labels: runpanel("memebot2") },
          { name: "someone-elses", labels: {} },
        ],
      });
      const found = await ops.discoverVolumes(docker.cli, owner);
      const names = found.map((v) => v.name);

      r.check(
        "a Compose stack's volume is found by its project label",
        names.includes("runpanel-memebot_memebot-data"),
        names.join(", ")
      );
      r.check(
        "and reported as Compose's, with its name in the compose file",
        found.find((v) => v.name === "runpanel-memebot_memebot-data")?.origin === "compose" &&
          found.find((v) => v.name === "runpanel-memebot_memebot-data")?.composeVolume === "memebot-data"
      );
      r.check(
        "a RunPanel-labelled volume is still found, as before",
        found.find((v) => v.name === "runpanel-postgres-memebot-db")?.origin === "runpanel"
      );
      r.check(
        "a stack whose name only starts the same is not collected",
        !names.includes("runpanel-memebot2_data"),
        names.join(", ")
      );
      r.check(
        "nor is a RunPanel volume of a project whose slug only starts the same",
        !names.includes("runpanel-postgres-memebot2-db"),
        names.join(", ")
      );
      r.check("an unlabelled volume never is", !names.includes("someone-elses"));

      const asked = docker.calls.map(({ args }) => args.join(" "));
      r.check(
        "the stack is asked for by the whole compose project name",
        asked.some((line) => line.includes(`--filter label=com.docker.compose.project=${STACK} `)),
        asked.join(" | ")
      );
      r.check(
        "RunPanel's own volumes are asked for with ownedFilters, unchanged",
        asked.some((line) => line.includes(labels.ownedFilters({ project: SLUG }).join(" "))),
        asked.join(" | ")
      );
      r.check("discovery only reads", docker.destructive().length === 0);
    }

    {
      const docker = simulatedDocker({
        volumes: [{ name: "both", labels: { ...runpanel(SLUG), ...compose(STACK, "both") } }],
      });
      const found = await ops.discoverVolumes(docker.cli, owner);
      r.check("a volume with both kinds of label is listed once", found.length === 1, JSON.stringify(found));
    }

    // --- who is using a volume ------------------------------------------------------
    {
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", [{ name: "runpanel-memebot_memebot-data", rw: true }]),
          stackContainer("c2", "viewer", [{ name: "runpanel-memebot_memebot-data", rw: false }]),
          // Mounts a volume whose name CONTAINS the one asked for.
          stackContainer("c3", "other", [{ name: "runpanel-memebot_memebot-data-old", rw: true }]),
          {
            id: "c4",
            name: "stranger",
            labels: { "com.docker.compose.project": "runpanel-memebot2" },
            mounts: [{ name: "runpanel-memebot_memebot-data", rw: true }],
          },
        ],
      });
      const users = await ops.volumeUsers(docker.cli, "runpanel-memebot_memebot-data", owner);
      const byName = Object.fromEntries(users.map((u) => [u.name, u]));
      r.check("a container mounting a longer name is not a user", !byName["memebot-other"], Object.keys(byName).join(", "));
      r.check("a writer is reported read-write", byName["memebot-record"]?.rw === true);
      r.check("a reader is reported read-only", byName["memebot-viewer"]?.rw === false);
      r.check("the stack's containers are the project's", byName["memebot-record"]?.owned === true);
      r.check(
        "a stack whose name only starts the same is not",
        byName.stranger?.owned === false,
        JSON.stringify(byName.stranger)
      );
    }

    // --- restore: nothing may have the volume open ----------------------------------
    {
      // The driver's `compose stop` failed quietly: the stack is still up.
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", [{ name: "runpanel-memebot_memebot-data", rw: true }]),
          stackContainer("c2", "label", [{ name: "runpanel-memebot_memebot-data", rw: true }], "paused"),
          stackContainer("c3", "telegram", [{ name: "runpanel-memebot_memebot-data", rw: true }], "exited"),
        ],
      });
      log.length = 0;
      const held = [];
      await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say, held);
      r.check("what the stop left running is stopped here", held.includes("c1") && held.includes("c2"), held.join(","));
      r.check("an already stopped container is left alone", !held.includes("c3"));
      r.check("the paused one is unpaused before it is stopped", docker.verbs().indexOf("unpause") < docker.verbs().lastIndexOf("stop"));

      await ops.writeVolume(docker.cli, {
        volume: "runpanel-memebot_memebot-data",
        image: "alpine",
        archive: join(scratch, "volume.tar.gz"),
        log: say,
      });
      const write = docker.calls.find((call) => call.args[0] === "run" && call.source);
      r.check(
        "the volume is written with the whole stack down",
        write?.users.every((u) => u.state === "exited"),
        JSON.stringify(write?.users)
      );
      r.check(
        "into that volume and nothing else",
        write?.args.includes("runpanel-memebot_memebot-data:/to"),
        write?.args.join(" ")
      );

      await ops.startContainers(docker.cli, held, say);
      r.check(
        "and what was stopped for it comes back",
        ["c1", "c2"].every((id) => docker.container(id).state === "running"),
        docker.state.containers.map((c) => `${c.name}:${c.state}`).join(", ")
      );
      r.check("the telegram container stays as it was", docker.container("c3").state === "exited");
      r.check("the restore sequence deletes nothing", docker.destructive().length === 0, JSON.stringify(docker.destructive()));
    }

    {
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", [{ name: "runpanel-memebot_memebot-data", rw: true }], "exited"),
          {
            id: "c9",
            name: "somebody-else",
            labels: {},
            mounts: [{ name: "runpanel-memebot_memebot-data", rw: false }],
          },
        ],
      });
      let refused = null;
      try {
        await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say, []);
      } catch (err) {
        refused = err;
      }
      r.check("a container that is not the project's blocks the restore", refused !== null);
      r.check("and is named in the reason", String(refused?.message).includes("somebody-else"), refused?.message);
      r.check("it is not stopped on the project's behalf", docker.container("c9").state === "running");
      r.check("nothing was stopped at all", !docker.verbs().includes("stop"));
    }

    {
      // Something restarts faster than the stop can hold it down.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", [{ name: "runpanel-memebot_memebot-data", rw: true }])],
        hooks: {
          stop: (args, state) => {
            state.containers[0].state = "restarting";
            return "";
          },
        },
      });
      let refused = null;
      try {
        await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say, []);
      } catch (err) {
        refused = err;
      }
      r.check("a container that will not stay down stops the restore", refused !== null, String(refused?.message));
    }

    // --- export: the writers are frozen for the copy, and only for the copy ----------
    const VOLUME = "runpanel-memebot_memebot-data";
    const rw = [{ name: VOLUME, rw: true }];
    const journalSpy = () => {
      const events = [];
      return {
        events,
        journal: {
          record: (ids) => events.push(["record", [...ids]]),
          release: (ids) => events.push(["release", [...ids]]),
        },
      };
    };
    let exportCount = 0;
    const exportRequest = (docker, overrides = {}) => {
      const n = exportCount++;
      const spy = overrides.spy ?? journalSpy();
      return {
        spy,
        request: {
          volume: VOLUME,
          owner,
          image: "alpine",
          consistency: "pause",
          excludes: [],
          destination: join(scratch, `export-${n}.tar.gz`),
          scratch: join(scratch, `export-${n}.raw.tar`),
          freeBytes: () => 100 * 1024 ** 3,
          reserveBytes: 2 * 1024 ** 3,
          pauseLimitMs: 60_000,
          journal: spy.journal,
          retryDelayMs: 1,
          log: say,
          ...overrides.request,
        },
      };
    };
    const du = () => "2048\t/from";

    {
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", rw),
          stackContainer("c2", "viewer", [{ name: VOLUME, rw: false }]),
          stackContainer("c3", "label", rw, "paused"),
        ],
        hooks: { run: du },
      });
      log.length = 0;
      const { request, spy } = exportRequest(docker);
      const result = await ops.exportVolume(docker.cli, request);
      const copy = docker.calls.find((call) => call.args.includes("tar"));
      const at = Object.fromEntries((copy?.users ?? []).map((u) => [u.name, u.state]));

      r.check("the writer is paused while the volume is read", at["memebot-record"] === "paused", JSON.stringify(at));
      r.check("a read-only mount is left running", at["memebot-viewer"] === "running");
      r.check("the copy mounts the volume read-only", copy?.args.includes(`${VOLUME}:/from:ro`), copy?.args.join(" "));
      r.check(
        "while paused it is copied uncompressed, to the scratch file",
        copy?.compress === false && copy?.destination === request.scratch,
        JSON.stringify({ compress: copy?.compress, destination: copy?.destination })
      );
      r.check("the writer runs again afterwards", docker.container("c1").state === "running");
      r.check(
        "one somebody else had paused is neither paused nor resumed by the backup",
        docker.container("c3").state === "paused" &&
          !docker.calls.some(({ args }) => ["pause", "unpause"].includes(args[0]) && args.includes("c3"))
      );
      r.check(
        "the journal is written before the pause and cleared after",
        JSON.stringify(spy.events) === JSON.stringify([["record", ["c1"]], ["release", ["c1"]]]),
        JSON.stringify(spy.events)
      );
      r.check(
        "the archive is compressed once they are running",
        (() => {
          try {
            return zlibGunzip(fs.readFileSync(request.destination)).toString() === `tar of ${VOLUME}\n`;
          } catch {
            return false;
          }
        })()
      );
      r.check("and the scratch copy is gone", !fs.existsSync(request.scratch));
      r.check(
        "the report says the copy is consistent, and who was paused",
        result.consistency.result === "paused" &&
          result.consistency.paused.join() === "memebot-record" &&
          typeof result.consistency.pausedMs === "number",
        JSON.stringify(result.consistency)
      );
      r.check("the log says who was paused", log.some((line) => line.includes("in pausa: memebot-record")), log.join(" | "));
      r.check("and for how long", log.some((line) => /ripresi dopo \d+,\d s di pausa/.test(line)), log.join(" | "));
      r.check("the backup deletes nothing", docker.destructive().length === 0, JSON.stringify(docker.destructive()));
    }

    {
      // The copy fails halfway: the writers must come back regardless.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw), stackContainer("c2", "label", rw)],
        hooks: {
          run: du,
          toFile: () => {
            throw new Error("tar: read error");
          },
        },
      });
      const { request, spy } = exportRequest(docker);
      let failed = null;
      try {
        await ops.exportVolume(docker.cli, request);
      } catch (err) {
        failed = err;
      }
      r.check("a failed copy is reported", String(failed?.message).includes("tar: read error"), String(failed));
      r.check(
        "and every writer is resumed anyway",
        ["c1", "c2"].every((id) => docker.container(id).state === "running"),
        docker.state.containers.map((c) => `${c.name}:${c.state}`).join(", ")
      );
      r.check(
        "and both are released from the journal",
        JSON.stringify(spy.events.at(-1)) === JSON.stringify(["release", ["c1", "c2"]]),
        JSON.stringify(spy.events)
      );
    }

    {
      // A copy that runs past the limit is cut short, and the pause with it.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          run: du,
          toFile: (_args, _state, opts) =>
            new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("killed")))),
        },
      });
      const { request } = exportRequest(docker, { request: { pauseLimitMs: 50 } });
      let failed = null;
      try {
        await ops.exportVolume(docker.cli, request);
      } catch (err) {
        failed = err;
      }
      r.check("a pause past its limit ends the copy", /limite/.test(String(failed?.message)), String(failed?.message));
      r.check("and the writer is running again", docker.container("c1").state === "running");
    }

    {
      // Not enough room for the uncompressed copy: compress while paused, and say so.
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)], hooks: { run: du } });
      log.length = 0;
      const { request } = exportRequest(docker, {
        request: { freeBytes: () => 2 * 1024 ** 3 + 1024, reserveBytes: 2 * 1024 ** 3 },
      });
      const result = await ops.exportVolume(docker.cli, request);
      const copy = docker.calls.find((call) => call.args.includes("tar"));
      r.check(
        "without room it is compressed straight into the archive",
        copy?.compress === true && copy?.destination === request.destination && result.consistency.method === "stream"
      );
      r.check("still with the writer paused", copy?.users.find((u) => u.name === "memebot-record")?.state === "paused");
      r.check("and the log says the pause will be longer", log.some((line) => line.includes("spazio insufficiente")), log.join(" | "));
    }

    {
      // Room for the raw copy but not for it and its compressed twin together.
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)], hooks: { run: du } });
      const { request } = exportRequest(docker, {
        request: { freeBytes: () => 2 * 1024 ** 3 + 3 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 },
      });
      const result = await ops.exportVolume(docker.cli, request);
      r.check(
        "the uncompressed copy needs room for its compressed version too",
        result.consistency.method === "stream",
        JSON.stringify(result.consistency)
      );
    }

    {
      // Copy while live, as the project asked: no pause, and it is said.
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)], hooks: { run: du } });
      log.length = 0;
      const { request } = exportRequest(docker, { request: { consistency: "live" } });
      const result = await ops.exportVolume(docker.cli, request);
      r.check("a live copy pauses nothing", !docker.verbs().includes("pause"));
      r.check("and is marked live", result.consistency.result === "live", JSON.stringify(result.consistency));
      r.check("and the log warns about it", log.some((line) => line.includes("ATTENZIONE") && line.includes("memebot-record")), log.join(" | "));
    }

    {
      // Nothing is writing: no pause is needed, and none happens.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw, "exited"), stackContainer("c2", "viewer", [{ name: VOLUME, rw: false }])],
      });
      const { request, spy } = exportRequest(docker);
      const result = await ops.exportVolume(docker.cli, request);
      r.check("with no writer running, nothing is paused", !docker.verbs().includes("pause") && spy.events.length === 0);
      r.check("and the copy is consistent", result.consistency.result === "idle", JSON.stringify(result.consistency));
    }

    {
      // A writer that is not this project's: never paused on its behalf, and never silent.
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", rw),
          { id: "c9", name: "intruder", labels: { "com.docker.compose.project": "runpanel-memebot2" }, mounts: rw },
        ],
        hooks: { run: du },
      });
      log.length = 0;
      const { request } = exportRequest(docker);
      const result = await ops.exportVolume(docker.cli, request);
      r.check("another project's writer is not paused", !docker.calls.some(({ args }) => args[0] === "pause" && args.includes("c9")));
      r.check("the project's own writer still is", docker.calls.some(({ args }) => args[0] === "pause" && args.includes("c1")));
      r.check("the copy is marked live", result.consistency.result === "live", JSON.stringify(result.consistency));
      r.check("and the log names the container", log.some((line) => line.includes("intruder") && line.includes("ATTENZIONE")), log.join(" | "));
    }

    {
      // A container that cannot be resumed stays in the journal for the next boot.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          run: du,
          unpause: () => {
            throw new Error("daemon busy");
          },
        },
      });
      log.length = 0;
      const { request, spy } = exportRequest(docker);
      await ops.exportVolume(docker.cli, request);
      r.check(
        "a container that could not be resumed stays in the journal",
        JSON.stringify(spy.events.at(-1)) === JSON.stringify(["release", []]),
        JSON.stringify(spy.events)
      );
      r.check("and the log says so", log.some((line) => line.startsWith("  ERRORE") && line.includes("memebot-record")));
    }

    {
      // The client gave up on `docker pause`, the daemon carried it out anyway.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          run: du,
          pause: (args, state) => {
            state.containers[0].state = "paused";
            throw new Error("context deadline exceeded");
          },
        },
      });
      const { request, spy } = exportRequest(docker);
      const result = await ops.exportVolume(docker.cli, request);
      r.check(
        "a pause that timed out on the client but happened is still undone",
        docker.container("c1").state === "running",
        docker.container("c1").state
      );
      r.check("and released from the journal", JSON.stringify(spy.events.at(-1)) === JSON.stringify(["release", ["c1"]]));
      r.check("the copy is not claimed consistent", result.consistency.result === "live", JSON.stringify(result.consistency));
    }

    {
      // Cancelled before the copy: nothing is frozen.
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)], hooks: { run: du } });
      const controller = new AbortController();
      controller.abort();
      const { request } = exportRequest(docker, { request: { signal: controller.signal } });
      let failed = null;
      try {
        await ops.exportVolume(docker.cli, request);
      } catch (err) {
        failed = err;
      }
      r.check("a cancelled backup pauses nothing", failed !== null && !docker.verbs().includes("pause"), String(failed));
    }

    {
      // No room for the raw copy, and far too big to compress within the limit.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: { run: () => `${40 * 1024 * 1024}\t/from` },
      });
      const { request } = exportRequest(docker, {
        request: { freeBytes: () => 3 * 1024 ** 3, reserveBytes: 2 * 1024 ** 3, pauseLimitMs: 10 * 60_000 },
      });
      let failed = null;
      try {
        await ops.exportVolume(docker.cli, request);
      } catch (err) {
        failed = err;
      }
      r.check("a volume that cannot be compressed within the limit is refused", /non è stato salvato/.test(String(failed?.message)), String(failed?.message));
      r.check("before anything is frozen", !docker.verbs().includes("pause"));
    }

    {
      // The size cannot be told: compress while paused, with the fast level.
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)] });
      log.length = 0;
      const { request } = exportRequest(docker);
      await ops.exportVolume(docker.cli, request);
      const copy = docker.calls.find((call) => call.args.includes("tar"));
      r.check(
        "without an estimate the copy is compressed while paused",
        copy?.compress === true && copy?.users.find((u) => u.name === "memebot-record")?.state === "paused"
      );
      r.check("with the fastest gzip level", docker.calls.find((call) => call.args.includes("tar"))?.fast === true);
    }

    {
      // The raw copy grows past the room left: stopped before it eats the reserve.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          run: du,
          toFile: (_args, _state, opts, destination) => {
            fs.writeFileSync(destination, Buffer.alloc(12 * 1024 * 1024));
            return new Promise((_, reject) => {
              if (opts.signal.aborted) reject(new Error("killed"));
              opts.signal.addEventListener("abort", () => reject(new Error("killed")));
            });
          },
        },
      });
      const { request } = exportRequest(docker, {
        request: { freeBytes: () => 2 * 1024 ** 3 + 10 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 },
      });
      let failed = null;
      try {
        await ops.exportVolume(docker.cli, request);
      } catch (err) {
        failed = err;
      }
      r.check("a raw copy larger than its room is cut short", /superato lo spazio/.test(String(failed?.message)), String(failed?.message));
      r.check("and the writer is resumed", docker.container("c1").state === "running");
    }

    {
      // A writer that starts while the volume is being measured is paused too.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw), stackContainer("c2", "label", rw, "exited")],
        hooks: {
          run: (args, state) => {
            if (!args.includes("du -sk /from; for p in \"$@\"; do du -sk \"/from/$p\" 2>/dev/null || echo \"- /from/$p\"; done")) return undefined;
            state.containers[1].state = "running";
            return du();
          },
        },
      });
      const { request } = exportRequest(docker);
      await ops.exportVolume(docker.cli, request);
      const copy = docker.calls.find((call) => call.args.includes("tar"));
      r.check(
        "a writer started during the measurement is paused as well",
        copy?.users.find((u) => u.name === "memebot-label")?.state === "paused",
        JSON.stringify(copy?.users)
      );
    }

    {
      // Read-only at one path, read-write at another: a writer.
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", [{ name: VOLUME, rw: false }, { name: VOLUME, rw: true }])],
      });
      const [user] = await ops.volumeUsers(docker.cli, VOLUME, owner);
      r.check("a volume mounted twice, once read-write, counts as written", user?.rw === true, JSON.stringify(user));
    }

    {
      // Live copy, a failed command, and a stack that is running: refused.
      const failed = { service: "record", container: null, ok: false, ms: 1, error: "not running" };
      const running = simulatedDocker({ containers: [stackContainer("c1", "record", rw)] });
      let refused = null;
      try {
        await ops.exportVolume(running.cli, exportRequest(running, { request: { consistency: "live", preBackup: failed } }).request);
      } catch (err) {
        refused = err;
      }
      r.check("a live copy whose command failed is refused while something writes", refused !== null && !running.calls.some((c) => c.args.includes("tar")));

      const idle = simulatedDocker({ containers: [stackContainer("c1", "record", rw, "exited")] });
      const result = await ops.exportVolume(idle.cli, exportRequest(idle, { request: { consistency: "live", preBackup: failed } }).request);
      r.check("but goes ahead when nothing is writing", result.consistency.result === "idle", JSON.stringify(result.consistency));
    }

    {
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw)], hooks: { run: du } });
      await ops.exportVolume(docker.cli, exportRequest(docker).request);
      const helpers = docker.calls.filter(({ args }) => args[0] === "run");
      r.check(
        "no throwaway container writes its output into Docker's own logs",
        helpers.length > 0 && helpers.every(({ args }) => args.join(" ").includes("--log-driver none")),
        helpers.map(({ args }) => args.slice(0, 4).join(" ")).join(" | ")
      );
    }

    {
      // A stop that fails halfway still leaves the ones already stopped on the list.
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", [{ name: VOLUME, rw: true }]),
          stackContainer("c2", "label", [{ name: VOLUME, rw: true }]),
        ],
        hooks: {
          stop: (args, state) => {
            if (args.includes("c2")) throw new Error("timeout");
            state.containers[0].state = "exited";
            return "";
          },
        },
      });
      const held = [];
      try {
        await ops.holdVolumeForRestore(docker.cli, VOLUME, owner, say, held);
      } catch {
        /* expected */
      }
      r.check("containers stopped before a failure are still handed back to be started", held.includes("c1"), held.join(","));
    }

    // --- the pre-backup command ------------------------------------------------------
    {
      const docker = simulatedDocker({
        containers: [
          stackContainer("c1", "record", rw),
          // Same service name, in a stack whose name only starts the same.
          {
            id: "c9",
            name: "other-record",
            labels: { "com.docker.compose.project": "runpanel-memebot2", "com.docker.compose.service": "record" },
          },
        ],
      });
      log.length = 0;
      const hook = { service: "record", command: "python -m memebot snapshot", timeoutSec: 60 };
      const outcome = await ops.runPreBackup(docker.cli, owner, hook, say);
      const exec = docker.calls.find(({ args }) => args[0] === "exec");
      r.check(
        "the command runs in the stack's service",
        exec?.args[0] === "exec" && exec?.args[1] === "c1" && exec?.args.at(-1) === "python -m memebot snapshot",
        exec?.args.join(" ")
      );
      r.check(
        "handed to the shell as $0, not spliced into its script",
        exec?.args.length === 6 && !exec?.args[4].includes("memebot"),
        JSON.stringify(exec?.args)
      );
      r.check(
        "and bounded inside the container too, when it has `timeout`",
        exec?.args[4].includes("timeout -s KILL 60 sh -c \"$0\""),
        exec?.args[4]
      );
      r.check("and reports success", outcome.ok === true && outcome.container === "memebot-record", JSON.stringify(outcome));
    }

    {
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          exec: () => {
            throw new Error("sqlite3: database is locked");
          },
        },
      });
      const outcome = await ops.runPreBackup(docker.cli, owner, { service: "record", command: "x", timeoutSec: 5 }, say);
      r.check("a failing command is an outcome, not an exception", outcome.ok === false, JSON.stringify(outcome));
      r.check("carrying its reason", String(outcome.error).includes("database is locked"));
    }

    {
      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw, "exited")] });
      const outcome = await ops.runPreBackup(docker.cli, owner, { service: "record", command: "x", timeoutSec: 5 }, say);
      r.check("a service that is not running fails the command", outcome.ok === false && !docker.verbs().includes("exec"));
    }

    {
      const failed = { service: "record", container: null, ok: false, ms: 1, error: "locked" };
      r.check(
        "a failed command with the writers paused lets the copy go ahead",
        ops.preBackupBlocks(failed, "pause", true) === null
      );
      r.check(
        "with a live copy it stops it, saying why",
        String(ops.preBackupBlocks(failed, "live", true)).includes("locked")
      );
      r.check(
        "a command that worked never stops anything",
        ops.preBackupBlocks({ ...failed, ok: true, error: undefined }, "live", true) === null
      );
      r.check("nor does having none", ops.preBackupBlocks(null, "live", true) === null);
      r.check(
        "nor a failed one when nothing is writing: the live copy is consistent anyway",
        ops.preBackupBlocks(failed, "live", false) === null
      );
    }

    // --- the settings, read tolerantly --------------------------------------------------
    {
      const { parseBackupSettings, DEFAULT_PRE_BACKUP_TIMEOUT_SEC, MAX_PRE_BACKUP_TIMEOUT_SEC } = await load(
        "lib",
        "backup-settings.ts"
      );
      r.check("no settings pause the writers", parseBackupSettings(null).consistency === "pause");
      r.check("unreadable settings do too", parseBackupSettings("{not json").consistency === "pause");
      r.check("an unknown mode falls back to pausing", parseBackupSettings('{"consistency":"yolo"}').consistency === "pause");
      r.check("a live copy is kept when asked for", parseBackupSettings('{"consistency":"live"}').consistency === "live");
      r.check(
        "a command with a bad service name is dropped",
        parseBackupSettings('{"preBackup":{"service":"-x","command":"true"}}').preBackup === null
      );
      const hook = parseBackupSettings('{"preBackup":{"service":"db","command":"pg_dump"}}').preBackup;
      r.check("a command gets the default timeout", hook?.timeoutSec === DEFAULT_PRE_BACKUP_TIMEOUT_SEC, JSON.stringify(hook));
      r.check(
        "and a timeout past the maximum is capped",
        parseBackupSettings('{"preBackup":{"service":"db","command":"pg_dump","timeoutSec":999999}}').preBackup?.timeoutSec ===
          MAX_PRE_BACKUP_TIMEOUT_SEC
      );
    }

    // --- exclusions ---------------------------------------------------------------------
    {
      const { normalizeExcludePath, normalizeExcludeList, parseBackupSettings, MAX_EXCLUDES_PER_VOLUME } = await load(
        "lib",
        "backup-settings.ts"
      );
      for (const [raw, expected] of [
        ["trades", "trades"],
        ["trades/", "trades"],
        ["./trades", "trades"],
        ["  cache/tmp  ", "cache/tmp"],
        [".cache", ".cache"],
        ["with space/x", "with space/x"],
        ["dati/città", "dati/città"],
      ]) {
        r.check(`exclusion "${raw}" is kept as "${expected}"`, normalizeExcludePath(raw) === expected, String(normalizeExcludePath(raw)));
      }
      for (const raw of ["", ".", "./", "/etc", "../x", "a/../b", "a//b", "*.parquet", "trades/[0-9]", "a\\b", "it's", "a\nb"]) {
        r.check(`exclusion ${JSON.stringify(raw)} is refused`, normalizeExcludePath(raw) === null, String(normalizeExcludePath(raw)));
      }
      r.check(
        "a list is deduplicated after normalising",
        JSON.stringify(normalizeExcludeList(["trades", "./trades/", "models"])) === '["trades","models"]'
      );
      r.check(
        "and capped",
        normalizeExcludeList(Array.from({ length: 80 }, (_, i) => `d${i}`)).length === MAX_EXCLUDES_PER_VOLUME
      );
      const stored = parseBackupSettings(
        JSON.stringify({ excludes: { [VOLUME]: ["trades/", "../etc"], "not a volume!": ["x"], empty: [] } })
      );
      r.check(
        "stored exclusions are read back normalised, the invalid ones dropped",
        JSON.stringify(stored.excludes) === JSON.stringify({ [VOLUME]: ["trades"] }),
        JSON.stringify(stored.excludes)
      );
    }

    {
      const args = ops.tarArgs(VOLUME, "alpine", ["trades", "cache/tmp"]);
      r.check(
        "each exclusion is anchored at the volume's root",
        args.includes("--exclude=./trades") && args.includes("--exclude=./cache/tmp"),
        args.join(" ")
      );
      r.check("and comes before the path being archived", args.indexOf("--exclude=./trades") < args.lastIndexOf("."));
      r.check("no exclusion, no --exclude", !ops.tarArgs(VOLUME, "alpine").some((a) => a.startsWith("--exclude")));
    }

    {
      const docker = simulatedDocker({
        containers: [stackContainer("c1", "record", rw)],
        hooks: {
          run: (args) =>
            args.includes("du -sk /from; for p in \"$@\"; do du -sk \"/from/$p\" 2>/dev/null || echo \"- /from/$p\"; done")
              ? "3000000\t/from\n480000\t/from/trades\n- /from/typo"
              : "",
        },
      });
      log.length = 0;
      const { request } = exportRequest(docker, { request: { excludes: ["trades", "typo"] } });
      const result = await ops.exportVolume(docker.cli, request);
      const copy = docker.calls.find((call) => call.args.includes("tar"));
      r.check("the copy leaves the excluded path out", copy?.args.includes("--exclude=./trades"), copy?.args.join(" "));
      r.check(
        "the paths are handed to the measuring shell as arguments, not spliced into it",
        docker.calls.some(({ args }) => args.at(-2) === "trades" && args.at(-1) === "typo" && args.includes("sh"))
      );
      r.check(
        "the log says what was excluded, and how much",
        log.some((line) => line.includes("esclusi: trades (469 MB)")),
        log.join(" | ")
      );
      r.check(
        "and which exclusion matched nothing",
        log.some((line) => line.includes("typo (non presente nel volume)")),
        log.join(" | ")
      );
      r.check(
        "the report lists them with their sizes",
        JSON.stringify(result.excluded) ===
          JSON.stringify([
            { path: "trades", bytes: 480000 * 1024, missing: false },
            { path: "typo", bytes: null, missing: true },
          ]),
        JSON.stringify(result.excluded)
      );
      r.check(
        "and the estimate leaves them out",
        result.estimatedBytes === (3000000 - 480000) * 1024,
        String(result.estimatedBytes)
      );
    }

    {
      // The restore keeps what the backup never had.
      const script = ops.restoreScript(["trades", "a/b"]);
      r.check("a restore with kept paths refuses to run outside the volume", script.startsWith("cd /to || exit 1;"), script);
      r.check(
        "the kept paths and everything under them are spared",
        script.includes("-path './trades' -o -path './trades/*'") && script.includes("-path './a/b' -o -path './a/b/*'"),
        script
      );
      r.check("the find grouping is escaped for the shell", script.includes("\\( -path") && script.includes("\\) -prune"), script);
      r.check("and the archive is still unpacked last", script.endsWith("; tar -xf - -C /to"), script);
      r.check("a quote cannot break out of a pattern", ops.restoreScript(["it's"]).includes(`'./it'"'"'s'`));

      const docker = simulatedDocker({ containers: [stackContainer("c1", "record", rw, "exited")] });
      log.length = 0;
      await ops.writeVolume(docker.cli, { volume: VOLUME, image: "alpine", archive: join(scratch, "v.tar.gz"), keep: ["trades"], log: say });
      const write = docker.calls.find((call) => call.source);
      r.check("the write carries the keeping script", write?.args.at(-1) === ops.restoreScript(["trades"]), write?.args.at(-1));
      r.check("and the log says what was kept", log.some((line) => line.includes("conservati come sono") && line.includes("trades")));
    }

    r.check(
      "the restore script without exclusions is the one it always was",
      ops.restoreScript() === "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; tar -xf - -C /to",
      ops.restoreScript()
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return r.result();
}
