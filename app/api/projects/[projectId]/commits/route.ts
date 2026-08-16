import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { githubFetch, githubToken, parseRepoSlug } from "@/lib/github";
import { commitsQuerySchema } from "@/lib/validation";

type Params = { params: Promise<{ projectId: string }> };

const DEFAULT_PER_PAGE = 20;

interface GhCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
}

/**
 * The commits behind the version picker.
 *
 * Project-scoped rather than `/api/github/commits?repo=`: here the project
 * exists, so the slug comes from `parseRepoSlug(project.source_url)` — a value
 * `repoUrlSchema` already validated on the way in. The dangerous parameter
 * disappears instead of being filtered, which is also why this route needs no
 * third copy of the `owner/name` pattern.
 *
 * ## Why "cannot list" is a 200
 *
 * `useResource` throws on any non-2xx (`if (!res.ok) throw new Error(...)`), so
 * the body of an error response never reaches the component. A 404 carrying a
 * careful Italian explanation is an explanation nobody reads. Every state the
 * picker can render — no repository, no token, repository not visible, rate
 * limited — therefore comes back as a 200 with `available: false` and the
 * sentence to show. Non-2xx is kept for the two cases that are not renderable:
 * the caller asked wrongly, or the panel is broken.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  const query = commitsQuerySchema.safeParse({
    branch: request.nextUrl.searchParams.get("branch") ?? undefined,
    perPage: request.nextUrl.searchParams.get("perPage") ?? undefined,
    page: request.nextUrl.searchParams.get("page") ?? undefined,
  });

  if (!query.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: query.error.issues, commits: [] },
      { status: 400 }
    );
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "source_type", "source_url", "source_branch"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const branch = query.data.branch ?? project.source_branch;
  const perPage = query.data.perPage ?? DEFAULT_PER_PAGE;
  const page = query.data.page ?? 1;

  const unavailable = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
    NextResponse.json({
      available: false,
      reason,
      message,
      branch,
      commits: [],
      page,
      hasMore: false,
      ...extra,
    });

  const slug = project.source_type === "github" ? parseRepoSlug(project.source_url) : null;
  if (!slug) {
    return unavailable(
      "no-repo",
      "Questo progetto non parte da un repository GitHub: non c'è una cronologia di commit da cui scegliere."
    );
  }

  const token = await githubToken();
  if (!token) {
    return unavailable(
      "no-token",
      "Collega un account GitHub per sfogliare i commit. Il deploy di uno SHA funziona lo stesso, se il repository è pubblico."
    );
  }

  try {
    const res = await githubFetch(
      `/repos/${slug.full}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`,
      token
    );

    if (res.status === 404) {
      // GitHub answers 404 both for a repository this token cannot see and for a
      // branch that does not exist. Guessing which would be inventing, so the
      // message names both.
      return unavailable(
        "not-found",
        `Il repository o il branch "${branch}" non è raggiungibile con questo token.`
      );
    }

    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      return unavailable("rate-limited", "Limite di richieste GitHub raggiunto.", {
        retryAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
      });
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: "GitHub non ha risposto", commits: [] },
        { status: 502 }
      );
    }

    const batch = (await res.json()) as GhCommit[];

    return NextResponse.json({
      available: true,
      branch,
      page,
      hasMore: batch.length === perPage,
      commits: batch.map((entry) => ({
        sha: entry.sha,
        // Worked out once here rather than in every row of the list.
        shortSha: entry.sha.slice(0, 7),
        // First line only: the body of a merge commit is half a screen, and the
        // picker shows one line per commit.
        message: (entry.commit?.message ?? "").split("\n")[0] || "(senza messaggio)",
        // The login when GitHub matched the commit to an account, the name from
        // the commit itself otherwise — an author who never signed up still has
        // one, and the row would read blank.
        author: entry.author?.login ?? entry.commit?.author?.name ?? "",
        date: entry.commit?.author?.date ?? "",
        url: entry.html_url ?? "",
      })),
    });
  } catch {
    return NextResponse.json({ error: "GitHub non ha risposto", commits: [] }, { status: 502 });
  }
}
