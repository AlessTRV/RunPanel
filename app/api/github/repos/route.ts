import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/auth";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const stored = await getSetting("github_token");

  if (!stored) {
    return NextResponse.json({ error: "GitHub token not configured", repos: [] }, { status: 400 });
  }

  let token: string;
  try {
    token = decrypt(stored);
  } catch {
    return NextResponse.json({ error: "Failed to decrypt token", repos: [] }, { status: 500 });
  }

  try {
    const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated&type=owner", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "RunPanel",
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `GitHub API error: ${res.status}`, repos: [] }, { status: res.status });
    }

    const repos = await res.json();
    const simplified = repos.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      html_url: r.html_url,
      clone_url: r.clone_url,
      description: r.description,
      language: r.language,
      default_branch: r.default_branch,
      private: r.private,
      updated_at: r.updated_at,
    }));

    return NextResponse.json({ repos: simplified });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ error: message, repos: [] }, { status: 500 });
  }
}
