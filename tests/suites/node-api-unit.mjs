import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Which server a page's API call goes to.
 *
 * Every page keeps writing `/api/...`; this helper decides whether that stays
 * on the panel serving the page or is forwarded to the selected member. Wrong
 * in one direction and a deploy lands on the wrong server; wrong in the other
 * and the login or cluster routes get forwarded and break.
 *
 * Standalone: `lib/node-api.ts` has no imports.
 */
export const meta = { name: "node-api-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("node-api-unit");
  const { nodeApiPath } = await import(pathToFileURL(join(repoRoot, "lib", "node-api.ts")).href);

  r.check("solo mode (no selection) is untouched", nodeApiPath(null, null, "/api/projects") === "/api/projects");
  r.check("the panel itself is untouched", nodeApiPath("self", "self", "/api/projects") === "/api/projects");
  r.check("another member is forwarded", nodeApiPath("n1", "self", "/api/projects") === "/api/nodes/n1/projects");
  r.check("query strings survive", nodeApiPath("n1", "self", "/api/projects/p1/stream?x=1") === "/api/nodes/n1/projects/p1/stream?x=1");
  r.check("an already forwarded path is left alone", nodeApiPath("n1", "self", "/api/nodes/n2/projects") === "/api/nodes/n2/projects");
  r.check("auth stays local", nodeApiPath("n1", "self", "/api/auth/me") === "/api/auth/me");
  r.check("cluster routes stay local", nodeApiPath("n1", "self", "/api/cluster") === "/api/cluster" && nodeApiPath("n1", "self", "/api/cluster/overview") === "/api/cluster/overview");
  r.check("a non-API path is left alone", nodeApiPath("n1", "self", "/projects/p1") === "/projects/p1");

  return r.result();
}
