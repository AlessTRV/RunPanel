import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What several servers answered, joined into one list.
 *
 * A row that loses its server cannot be opened or acted on; a server that did
 * not answer and is silently dropped makes a short list look complete; a
 * warning that is missed is a full disk nobody hears about.
 *
 * Standalone: `lib/cluster-merge.ts` has no imports.
 */
export const meta = { name: "cluster-merge-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cluster-merge-unit");
  const { mergeByMember, failedMembers, onlyMember, serverWarnings } = await import(
    pathToFileURL(join(repoRoot, "lib", "cluster-merge.ts")).href
  );

  const hh = { id: "hh", name: "hh", self: true };
  const or = { id: "or", name: "or", self: false };
  const ab = { id: "ab", name: "ab", self: false };

  // --- merging ------------------------------------------------------------------
  {
    const merged = mergeByMember([
      { member: or, items: [{ id: "p2" }] },
      { member: hh, items: [{ id: "p1" }, { id: "p3" }] },
      { member: ab, items: null },
    ]);
    r.check("every row carries its server", merged.every((x) => typeof x.memberId === "string" && typeof x.memberName === "string"));
    r.check("this server first, then by name", merged.map((x) => `${x.memberId}:${x.id}`).join() === "hh:p1,hh:p3,or:p2", merged.map((x) => `${x.memberId}:${x.id}`).join());
    r.check("a server with no data contributes no rows", !merged.some((x) => x.memberId === "ab"));
    r.check("the same id on two servers stays two rows", mergeByMember([{ member: hh, items: [{ id: "x" }] }, { member: or, items: [{ id: "x" }] }]).length === 2);
    r.check("filtering by server", onlyMember(merged, "or").map((x) => x.id).join() === "p2" && onlyMember(merged, null).length === 3);
  }

  // --- members that did not answer -----------------------------------------------
  {
    const members = [
      { id: "hh", name: "hh", self: true, ok: true, reachable: true, error: null },
      { id: "or", name: "or", self: false, ok: false, reachable: false, error: "Nessuna risposta" },
      { id: "ab", name: "ab", self: false, ok: false, reachable: true, error: "HTTP 403" },
    ];
    r.check("failed members are listed", failedMembers(members).map((m) => m.id).join() === "or,ab");
  }

  // --- warnings ---------------------------------------------------------------------
  {
    const GB = 1024 ** 3;
    const summary = (patch = {}) => ({
      version: "v1",
      docker: true,
      metrics: { cpu: 10, memory: { total: 8 * GB, used: 2 * GB }, disk: { total: 100 * GB, used: 50 * GB, free: 50 * GB }, uptime: 1 },
      projects: { total: 1, running: 1 },
      services: { total: 0, running: 0 },
      problems: 0,
      update: { behind: 0 },
      ...patch,
    });
    const disk = (free, total) => ({ metrics: { cpu: 0, memory: { total: 1, used: 0 }, disk: { total, used: total - free, free }, uptime: 1 } });
    const kinds = (s, o = {}) => serverWarnings(s, { reachable: true, panelVersion: "v1", ...o }).map((w) => w.kind).join();

    r.check("a healthy server has no warnings", kinds(summary()) === "");
    r.check("unreachable is the only warning when there is no answer", serverWarnings(null, { reachable: false, panelVersion: "v1" }).map((w) => w.kind).join() === "unreachable");
    r.check("3.2 GB free on 45 GB is low", kinds(summary(disk(3.2 * GB, 45 * GB))) === "disk-low", kinds(summary(disk(3.2 * GB, 45 * GB))));
    r.check("1.5 GB free is critical", kinds(summary(disk(1.5 * GB, 45 * GB))) === "disk-critical");
    r.check("2% of a big disk is critical", kinds(summary(disk(40 * GB, 2000 * GB))) === "disk-critical");
    r.check("a different version is flagged", kinds(summary({ version: "v0" })) === "version");
    r.check("Docker down is flagged", kinds(summary({ docker: false })) === "docker");
    r.check("open problems and a pending update are flagged", kinds(summary({ problems: 2, update: { behind: 3 } })) === "problems,update");
    const order = serverWarnings(summary({ ...disk(1 * GB, 45 * GB), version: "v0" }), { reachable: true, panelVersion: "v1" });
    r.check("the worst comes first", order[0].tone === "danger" && order[order.length - 1].tone === "warn");
    r.check("no metrics, no disk warning", kinds(summary({ metrics: null })) === "");
  }

  return r.result();
}
