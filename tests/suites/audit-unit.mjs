import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What the activity log records, and who gets to read which entry.
 *
 * Two rules matter most. Security events are recorded whatever the owner turns
 * off — a log where one can switch off one's own traces is not a log. And an
 * entry is shown only to someone who could see what it is about, or the log
 * becomes a side door listing projects nobody granted.
 */
export const meta = { name: "audit-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("audit-unit");
  const { AUDIT_CATEGORIES, parseEnabledCategories, shouldRecord, canSeeEntry, retentionCutoff, parseRetentionDays } =
    await import(pathToFileURL(join(repoRoot, "lib", "audit-filter.ts")).href);

  // --- categories ------------------------------------------------------------
  {
    const all = parseEnabledCategories(null);
    r.check("nothing stored records everything", AUDIT_CATEGORIES.every((c) => all.has(c)));
    const some = parseEnabledCategories(JSON.stringify(["deploy"]));
    r.check("a stored list is honoured", some.has("deploy") && !some.has("config"));
    r.check("security is always on", some.has("security"));
    r.check("garbage falls back to everything", parseEnabledCategories("{nope").size === AUDIT_CATEGORIES.length);
    r.check("unknown names are dropped", !parseEnabledCategories(JSON.stringify(["deploy", "bogus"])).has("bogus"));
    r.check("security records even when absent from the list", shouldRecord("security", new Set(["deploy"])));
    r.check("a disabled category does not record", !shouldRecord("config", new Set(["deploy"])));
  }

  // --- retention -------------------------------------------------------------
  {
    r.check("retention defaults to 90 days", parseRetentionDays(null) === 90);
    r.check("retention is clamped to at least a day", parseRetentionDays("0") === 1);
    r.check("retention is clamped to ten years", parseRetentionDays("99999") === 3650);
    r.check("garbage retention is the default", parseRetentionDays("abc") === 90);
    const now = new Date("2026-10-09T00:00:00.000Z");
    r.check("the cutoff is that many days back", retentionCutoff(10, now) === "2026-09-29T00:00:00.000Z", retentionCutoff(10, now));
  }

  // --- visibility ------------------------------------------------------------
  {
    const owner = { userId: "o", isOwner: true, permissions: new Set(), grants: [] };
    const user = (perms = []) => ({ userId: "u", isOwner: false, permissions: new Set(perms), grants: [] });
    const visible = { projects: new Set(["p1"]), services: new Set(["s1"]), folders: new Set(["f1"]) };
    const e = (category, scope = null, scopeId = null) => ({ category, scope, scopeId });

    r.check("the owner sees everything", canSeeEntry(owner, e("security", "user", "x"), visible));
    r.check("a visible project's entry is shown", canSeeEntry(user(), e("deploy", "project", "p1"), visible));
    r.check("another project's entry is hidden", !canSeeEntry(user(), e("deploy", "project", "p2"), visible));
    r.check("a visible service's entry is shown", canSeeEntry(user(), e("terminal", "service", "s1"), visible));
    r.check("a folder entry follows folder visibility", !canSeeEntry(user(), e("delete", "folder", "f2"), visible));
    r.check("a panel entry needs that permission", canSeeEntry(user(["backup"]), e("backup", "permission", "backup"), visible));
    r.check("without it the panel entry is hidden", !canSeeEntry(user(["monitor"]), e("backup", "permission", "backup"), visible));
    r.check("security entries need users.manage", !canSeeEntry(user(["backup"]), e("security", "user", "x"), visible));
    r.check("users.manage sees security entries", canSeeEntry(user(["users.manage"]), e("security", null, null), visible));
    r.check("an entry about nothing is the owner's", !canSeeEntry(user(["backup"]), e("system", null, null), visible));
  }

  return r.result();
}
