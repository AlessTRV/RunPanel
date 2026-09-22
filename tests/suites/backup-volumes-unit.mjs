import { createReporter } from "../harness.mjs";
import { simulatedDocker } from "../simulated-docker.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";

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
      const held = await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say);
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
        await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say);
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
        await ops.holdVolumeForRestore(docker.cli, "runpanel-memebot_memebot-data", owner, say);
      } catch (err) {
        refused = err;
      }
      r.check("a container that will not stay down stops the restore", refused !== null, String(refused?.message));
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
