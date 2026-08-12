import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { isPathShapeSafe, resolveInside } from "@/lib/fs-safe";
import { getRepoPath } from "@/services/git-manager";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "@/lib/config";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".br",
  ".exe", ".dll", ".so", ".dylib", ".node",
  ".mp3", ".mp4", ".wav", ".avi",
  ".pdf", ".doc", ".xls",
]);

/**
 * Note on the two runtimes below.
 *
 * For a Docker project this file manager browses the CONTAINER from `/` — the
 * listing endpoint runs `ls -la /` and the terminal tab opens a shell in the
 * same place. An absolute path there is the feature, not an escape, so the
 * Docker branch is left alone deliberately.
 *
 * The local branch is different: it is scoped to one project's checkout, and
 * that scope is what `resolveInside` enforces.
 */

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// GET: Read file content
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const filePath = request.nextUrl.searchParams.get("path");

  if (!filePath || !isPathShapeSafe(filePath)) {
    return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
  }

  if (isBinary(filePath)) {
    return NextResponse.json({ error: "I file binari non si possono modificare dal pannello" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  try {
    if (project.runtime_type === "docker") {
      const containerName = `runpanel-${project.slug}`;
      const tmpDir = config.tmpDir;
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${project.slug}-${Date.now()}`);

      await exec("docker", ["cp", `${containerName}:${filePath}`, tmpFile], { timeout: 10_000 });

      const stat = fs.statSync(tmpFile);
      if (stat.size > MAX_FILE_SIZE) {
        fs.rmSync(tmpFile);
        return NextResponse.json({ error: "File troppo grande per l'editor (massimo 1 MB)" }, { status: 400 });
      }

      const content = fs.readFileSync(tmpFile, "utf-8");
      fs.rmSync(tmpFile);
      return NextResponse.json({ content, path: filePath });
    }

    // Local
    const repoDir = getRepoPath(project.slug);
    const fullPath = resolveInside(repoDir, filePath);
    if (!fullPath) {
      return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File troppo grande per l'editor (massimo 1 MB)" }, { status: 400 });
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    return NextResponse.json({ content, path: filePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to read file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT: Write file content
export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const { path: filePath, content } = body as { path?: string; content?: string };

  if (!filePath || !isPathShapeSafe(filePath) || typeof content !== "string") {
    return NextResponse.json({ error: "Percorso o contenuto non validi" }, { status: 400 });
  }

  if (isBinary(filePath)) {
    return NextResponse.json({ error: "I file binari non si possono modificare dal pannello" }, { status: 400 });
  }

  if (content.length > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Contenuto troppo grande: il massimo è 1 MB" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  try {
    if (project.runtime_type === "docker") {
      const containerName = `runpanel-${project.slug}`;
      const tmpDir = config.tmpDir;
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${project.slug}-${Date.now()}`);

      fs.writeFileSync(tmpFile, content, "utf-8");
      await exec("docker", ["cp", tmpFile, `${containerName}:${filePath}`], { timeout: 10_000 });
      fs.rmSync(tmpFile);

      return NextResponse.json({ success: true });
    }

    // Local
    const repoDir = getRepoPath(project.slug);
    const fullPath = resolveInside(repoDir, filePath);
    if (!fullPath) {
      return NextResponse.json({ error: "Percorso non valido" }, { status: 400 });
    }

    fs.writeFileSync(fullPath, content, "utf-8");
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to write file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
