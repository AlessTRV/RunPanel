import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { githubToken, githubFetch } from "@/lib/github";

const PER_PAGE = 100;
const MAX_PAGES = 3;

/** `owner/name`, the only shape the GitHub branches endpoint accepts. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const repo = request.nextUrl.searchParams.get("repo") ?? "";

  // Validated rather than interpolated: this value reaches a URL path, and a
  // caller-supplied `../` would otherwise walk to a different API endpoint.
  if (!REPO_PATTERN.test(repo)) {
    return NextResponse.json({ error: "Expected repo=owner/name", branches: [] }, { status: 400 });
  }

  const token = await githubToken();
  if (!token) {
    return NextResponse.json({ connected: false, branches: [] });
  }

  const branches: { name: string; protected: boolean }[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await githubFetch(`/repos/${repo}/branches?per_page=${PER_PAGE}&page=${page}`, token);

      if (!res.ok) {
        return NextResponse.json(
          { connected: true, branches, error: `GitHub API error: ${res.status}` },
          { status: res.status }
        );
      }

      const batch = (await res.json()) as { name: string; protected?: boolean }[];
      for (const b of batch) branches.push({ name: b.name, protected: Boolean(b.protected) });
      if (batch.length < PER_PAGE) break;
    }

    return NextResponse.json({ connected: true, branches });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch branches";
    return NextResponse.json({ connected: true, branches: [], error: message }, { status: 500 });
  }
}
