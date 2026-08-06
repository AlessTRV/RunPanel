import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/auth";

const API = "https://api.github.com";

/**
 * The stored GitHub token, decrypted, or null when no account is connected.
 *
 * A decryption failure means the panel secret changed under a token encrypted
 * with the old one. That is indistinguishable from "not connected" as far as
 * callers are concerned — both mean there is no usable token — so it is
 * reported the same way rather than as a 500.
 */
export async function githubToken(): Promise<string | null> {
  const stored = await getSetting("github_token");
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

export function githubFetch(path: string, token: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RunPanel",
    },
    // These lists change on a human timescale; the panel re-reads them on every
    // wizard visit and does not need a cached copy from an earlier one.
    cache: "no-store",
  });
}
