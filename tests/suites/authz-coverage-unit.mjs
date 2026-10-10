import { createReporter } from "../harness.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every API handler says what it protects.
 *
 * `proxy.ts` refuses requests without a session, but a session is not a
 * permission: once several people share the panel, a handler that forgets its
 * guard hands every account full control of that route. This walks every
 * `route.ts` and requires each exported handler to call one of the guards from
 * `lib/auth-guard.ts`. The few public endpoints are listed by name, so adding
 * one is a visible edit here.
 */
export const meta = { name: "authz-coverage-unit", needsDocker: false, drivers: [], standalone: true };

const PUBLIC = new Set([
  "auth/check/route.ts",
  "auth/login/route.ts",
  "auth/logout/route.ts",
  "auth/invite/route.ts",
  "webhooks/github/[projectId]/route.ts",
]);

const GUARD = /await\s+require(User|Owner|Permission|Project|Service|Folder)\s*\(/;
const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

export async function run({ repoRoot }) {
  const r = createReporter("authz-coverage-unit");
  const apiDir = join(repoRoot, "app", "api");
  const files = walk(apiDir);
  r.check("routes are found", files.length > 50, String(files.length));

  const unguarded = [];
  const legacy = [];
  for (const file of files) {
    const rel = relative(apiDir, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    if (/\brequireAuth\b/.test(source)) legacy.push(rel);
    if (PUBLIC.has(rel)) continue;

    const starts = [...source.matchAll(HANDLER)];
    starts.forEach((m, i) => {
      const body = source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : source.length);
      if (!GUARD.test(body)) unguarded.push(`${rel} ${m[1]}`);
    });
  }

  r.check("every handler calls a guard", unguarded.length === 0, unguarded.join(", "));
  r.check("nothing uses the old requireAuth", legacy.length === 0, legacy.join(", "));
  return r.result();
}
