import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { githubToken, githubFetch } from "@/lib/github";

export interface GhRepoSummary {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  private: boolean;
  updated_at: string;
}

/** GitHub caps `per_page` at 100; five pages is 500 repositories. */
const PER_PAGE = 100;
const MAX_PAGES = 5;

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const token = await githubToken();

  // Not having connected an account is a normal state, not a failure — the
  // caller renders a "connect" prompt rather than an error toast.
  if (!token) {
    return NextResponse.json({ connected: false, repos: [] });
  }

  const repos: GhRepoSummary[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      // `affiliation` rather than `type=owner`: the previous query silently hid
      // every repository belonging to an organisation or shared with the user
      // as a collaborator, which for most accounts is the interesting half.
      const res = await githubFetch(
        `/user/repos?per_page=${PER_PAGE}&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`,
        token
      );

      if (!res.ok) {
        return NextResponse.json(
          { connected: true, repos, error: `GitHub API error: ${res.status}` },
          { status: res.status }
        );
      }

      const batch = (await res.json()) as Record<string, unknown>[];
      for (const r of batch) {
        repos.push({
          id: r.id as number,
          name: r.name as string,
          full_name: r.full_name as string,
          html_url: r.html_url as string,
          clone_url: r.clone_url as string,
          description: (r.description as string) ?? null,
          language: (r.language as string) ?? null,
          default_branch: r.default_branch as string,
          private: Boolean(r.private),
          updated_at: r.updated_at as string,
        });
      }

      // A short page is the last page.
      if (batch.length < PER_PAGE) break;
    }

    return NextResponse.json({ connected: true, repos });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ connected: true, repos: [], error: message }, { status: 500 });
  }
}
