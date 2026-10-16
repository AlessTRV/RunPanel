/**
 * Where a page sends an API call when a server other than this one is selected.
 *
 * Pages keep writing `/api/projects` and the like; this helper turns that into
 * `/api/nodes/<id>/projects` when the selected member is not the install
 * serving the page. Zero imports so the unit suite can load it.
 */
export const NODE_API_PREFIX = "/api/nodes/";

export function nodeApiPath(nodeId: string | null, selfId: string | null, path: string): string {
  if (!nodeId || nodeId === selfId) return path;
  if (!path.startsWith("/api/")) return path;
  if (path.startsWith(NODE_API_PREFIX)) return path;
  // Paths that must stay on the panel serving the page, whatever is selected.
  if (path.startsWith("/api/auth/") || path.startsWith("/api/cluster") || path.startsWith("/api/nodes")) return path;
  return `${NODE_API_PREFIX}${nodeId}/${path.slice("/api/".length)}`;
}
