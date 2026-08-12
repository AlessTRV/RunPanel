import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { isPathShapeSafe, resolveInside } from "@/lib/fs-safe";
import { getRepoPath } from "@/services/git-manager";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const dirPath = request.nextUrl.searchParams.get("path") || "/";

  if (!isPathShapeSafe(dirPath)) {
    return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type", "status"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  try {
    if (project.runtime_type === "docker") {
      // Docker: use docker exec to list files
      const containerName = `runpanel-${project.slug}`;
      const targetPath = dirPath === "/" ? "/" : dirPath;
      const { stdout } = await exec("docker", [
        "exec", containerName, "ls", "-la", "--time-style=+%Y-%m-%d", targetPath,
      ], { timeout: 10_000 });

      const entries = stdout.split("\n").slice(1).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 7) return null;
        const isDir = parts[0].startsWith("d");
        const size = parseInt(parts[4]) || 0;
        const name = parts.slice(6).join(" ");
        if (name === "." || name === "..") return null;
        return { name, type: isDir ? "dir" : "file", size };
      }).filter(Boolean);

      return NextResponse.json({ entries, path: dirPath });
    }

    // Local: read from repos directory
    const repoDir = getRepoPath(project.slug);

    // A project whose source was never checked out has no repo directory at
    // all. Reporting that as "Path not found" sends you looking for a missing
    // folder inside a project that has no code in the first place — the same
    // confusion the deploy pipeline already words properly.
    if (!fs.existsSync(repoDir)) {
      return NextResponse.json(
        {
          error:
            "The project has no source yet — configure a GitHub repository or upload a ZIP, then deploy.",
        },
        { status: 404 }
      );
    }

    // Resolved through any symlinks, so a link in the repository cannot be used
    // to list a directory outside it.
    const fullPath = resolveInside(repoDir, dirPath === "/" ? "." : dirPath);
    if (!fullPath) {
      return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "Percorso inesistente" }, { status: 404 });
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    const entries = items
      .filter((item) => item.name !== "node_modules" && item.name !== ".git")
      .map((item) => {
        const itemPath = path.join(fullPath, item.name);
        let size = 0;
        try { if (item.isFile()) size = fs.statSync(itemPath).size; } catch {}
        return {
          name: item.name,
          type: item.isDirectory() ? "dir" : "file",
          size,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: dirPath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to list files";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
