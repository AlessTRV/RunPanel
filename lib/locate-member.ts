/**
 * Ask the panel which server of the cluster holds a project or a service.
 *
 * Used when a page opens an id that its server answered with 404: the link may
 * have been made on another server. Plain fetch (not the forwarded `api()`):
 * the lookup itself fans out across the cluster. Null when nobody has it or the
 * lookup failed, so the caller falls back to its ordinary not-found behaviour.
 */
export async function locateMember(kind: "project" | "service", id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/cluster/locate?kind=${kind}&id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { memberId?: string | null };
    return typeof data.memberId === "string" ? data.memberId : null;
  } catch {
    return null;
  }
}
