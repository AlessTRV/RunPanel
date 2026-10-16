import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The server a page is about, carried in its URL.
 *
 * Every link in a cluster goes through these two functions: if they drop the
 * parameter, a link to a project on another server opens on the wrong one; if
 * they mangle the query or the hash, tabs and anchors stop working.
 *
 * Standalone: `lib/server-url.ts` has no imports.
 */
export const meta = { name: "server-url-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("server-url-unit");
  const { withServer, serverFromSearch, isAggregatePath } = await import(pathToFileURL(join(repoRoot, "lib", "server-url.ts")).href);

  r.check("adds the server to a bare path", withServer("/projects/abc", "or1") === "/projects/abc?server=or1");
  r.check("keeps other parameters", withServer("/projects/abc?tab=logs", "or1") === "/projects/abc?tab=logs&server=or1", withServer("/projects/abc?tab=logs", "or1"));
  r.check("keeps the hash", withServer("/backups#runs", "or1") === "/backups?server=or1#runs", withServer("/backups#runs", "or1"));
  r.check("replaces an existing server", withServer("/home?server=a", "b") === "/home?server=b");
  r.check("null removes it", withServer("/home?server=a&x=1", null) === "/home?x=1", withServer("/home?server=a&x=1", null));
  r.check("API paths are left alone", withServer("/api/projects", "or1") === "/api/projects");
  r.check("absolute URLs are left alone", withServer("https://example.com/x", "or1") === "https://example.com/x");
  r.check("protocol-relative URLs are left alone", withServer("//evil.example/x", "or1") === "//evil.example/x");

  r.check("reads the server from a query string", serverFromSearch("?tab=x&server=or1") === "or1");
  r.check("with or without the question mark", serverFromSearch("server=or1") === "or1");
  r.check("from URLSearchParams too", serverFromSearch(new URLSearchParams("server=or1")) === "or1");
  r.check("no parameter is null", serverFromSearch("?tab=x") === null && serverFromSearch("") === null && serverFromSearch(null) === null);
  r.check("a malformed id is ignored", serverFromSearch("?server=../../etc") === null && serverFromSearch("?server=") === null);

  r.check("lists aggregate", isAggregatePath("/projects") && isAggregatePath("/home") && isAggregatePath("/backups/"));
  r.check("single pages do not", !isAggregatePath("/projects/abc") && !isAggregatePath("/autostart") && !isAggregatePath("/settings"));

  return r.result();
}
