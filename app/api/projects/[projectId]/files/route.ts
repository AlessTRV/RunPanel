import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { getRepoPath } from "@/services/git-manager";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

function isPathSafe(relPath: string): boolean {
  if (relPath === "/" || relPath === "") return true; // root is always safe
  const cleaned = relPath.replace(/^\//, ""); // strip leading slash
  const normalized = path.normalize(cleaned);
  return !normalized.startsWith("..") && !path.isAbsolute(normalized) && !normalized.includes("..");
}

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const dirPath = request.nextUrl.searchParams.get("path") || "/";

  if (!isPathSafe(dirPath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const db = getDb();
  const project = db.prepare("SELECT slug, runtime_type, status FROM projects WHERE id = ?")
    .get(projectId) as { slug: string; runtime_type: string; status: string } | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
    // Normalize: "/" means root of repo, map to "."
    const safeDirPath = dirPath === "/" ? "." : dirPath.replace(/^\//, "");
    const fullPath = path.join(repoDir, safeDirPath);

    // Safety: ensure resolved path is inside repo
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoDir))) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
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
