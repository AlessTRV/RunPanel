/**
 * Which server a page is about, carried in its URL as `?server=<memberId>`.
 *
 * The parameter makes a link self-contained: a link to a project on another
 * server opens on that server whoever follows it. On a page about one thing
 * (a project, Autostart, Settings) no parameter means this server; on a list
 * (Projects, Services, Backups, Monitor…) no parameter means every server, and
 * the parameter narrows it to one.
 *
 * Zero imports, so the unit suite can load it.
 */

export const SERVER_PARAM = "server";

/** Pages that list every server at once when no server is named. */
const AGGREGATE_PATHS = ["/home", "/projects", "/services", "/backups", "/monitor", "/diagnostics", "/updates"];

export function isAggregatePath(pathname: string): boolean {
  return AGGREGATE_PATHS.includes(pathname.replace(/\/+$/, "") || "/");
}

/** The server named by a query string (`?a=1&server=x`, with or without `?`), or null. */
export function serverFromSearch(search: string | URLSearchParams | null | undefined): string | null {
  if (!search) return null;
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  const value = params.get(SERVER_PARAM);
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/**
 * `href` with the server parameter set (or removed when `serverId` is null).
 * Keeps the path, the other parameters and the hash; leaves absolute URLs and
 * API paths alone.
 */
export function withServer(href: string, serverId: string | null | undefined): string {
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return href;
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : beforeHash.slice(queryAt + 1));
  if (serverId) params.set(SERVER_PARAM, serverId);
  else params.delete(SERVER_PARAM);
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}
