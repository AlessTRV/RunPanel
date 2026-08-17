import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The rule that decides whether a green dot is a lie.
 *
 * `projects.status` used to be believed forever: the panel wrote it when it
 * started something and nothing ever came back to check, so a project whose
 * process died — or whose whole host went down with the panel — kept reporting
 * itself as running. The sweep in `services/status-reconcile.ts` fixes that,
 * and everything that could make the fix worse than the bug lives in this one
 * pure function: overwriting a status that a deploy owns, or flipping every
 * project to Stopped because one `pm2 jlist` came back empty.
 */
export const meta = { name: "status-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("status-unit");

  const { isReconcilable, reconciledStatus } = await import(
    pathToFileURL(join(repoRoot, "lib", "status.ts")).href
  );

  // --- which rows may be touched at all ------------------------------------
  r.check("a running row is reconcilable", isReconcilable("running") === true);
  r.check("a stopped row is reconcilable", isReconcilable("stopped") === true);
  // The deploy queue owns the row while it works, and `error` means the deploy
  // failed while the previous process kept running — neither answer here can
  // say that, so both would erase it.
  r.check("a deploying row is left to the queue", isReconcilable("deploying") === false);
  r.check("an error row keeps its outcome", isReconcilable("error") === false);
  r.check("an unknown status is not touched", isReconcilable("chi lo sa") === false);

  // --- coming up is written straight away ----------------------------------
  //
  // A driver reporting a process as running has just seen it. This is the
  // direction that fixes a boot where autostart brought everything back and
  // the column still said stopped.
  r.check(
    "a stopped row seen running is corrected on the first sighting",
    reconciledStatus("stopped", true, undefined) === "running"
  );
  r.check(
    "a running row seen running is left alone",
    reconciledStatus("running", true, undefined) === null
  );
  r.check(
    "and no write is invented when it was already running last time",
    reconciledStatus("running", true, true) === null
  );

  // --- going down has to be confirmed --------------------------------------
  //
  // The single most important pair in this file. `pm2 jlist` answers with an
  // empty listing when it fails mid-write, and Docker is still restarting its
  // own containers for the first half-minute after a reboot: acting on one
  // reading would paint the whole panel red and undo it a sweep later.
  r.check(
    "one sighting of a dead process is not enough to write it down",
    reconciledStatus("running", false, undefined) === null
  );
  r.check(
    "two agreeing sightings are",
    reconciledStatus("running", false, false) === "stopped"
  );
  r.check(
    "a sighting that contradicts the previous one waits for the next",
    reconciledStatus("running", false, true) === null
  );
  r.check(
    "a stopped row seen stopped needs no write",
    reconciledStatus("stopped", false, false) === null
  );

  // --- the states the sweep must never overwrite ---------------------------
  for (const [status, observed, previous] of [
    ["deploying", false, false],
    ["deploying", true, true],
    ["error", false, false],
    ["error", true, true],
  ]) {
    r.check(
      `a ${status} row is never rewritten (seen ${observed ? "up" : "down"})`,
      reconciledStatus(status, observed, previous) === null,
      String(reconciledStatus(status, observed, previous))
    );
  }

  return r.result();
}
