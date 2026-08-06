import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
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

function isPathSafe(relPath: string): boolean {
  if (relPath === "/" || relPath === "") return true;
  const cleaned = relPath.replace(/^\//, "");
  const normalized = path.normalize(cleaned);
  return !normalized.startsWith("..") && !path.isAbsolute(normalized) && !normalized.includes("..");
}

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// GET: Read file content
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const filePath = request.nextUrl.searchParams.get("path");

  if (!filePath || !isPathSafe(filePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  if (isBinary(filePath)) {
    return NextResponse.json({ error: "Binary files cannot be edited" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
        return NextResponse.json({ error: "File too large to edit (max 1MB)" }, { status: 400 });
      }

      const content = fs.readFileSync(tmpFile, "utf-8");
      fs.rmSync(tmpFile);
      return NextResponse.json({ content, path: filePath });
    }

    // Local
    const repoDir = getRepoPath(project.slug);
    const safeFilePath = filePath.replace(/^\//, "");
    const fullPath = path.join(repoDir, safeFilePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoDir))) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File too large to edit (max 1MB)" }, { status: 400 });
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
  const body = await request.json();
  const { path: filePath, content } = body as { path?: string; content?: string };

  if (!filePath || !isPathSafe(filePath) || typeof content !== "string") {
    return NextResponse.json({ error: "Invalid path or content" }, { status: 400 });
  }

  if (isBinary(filePath)) {
    return NextResponse.json({ error: "Binary files cannot be edited" }, { status: 400 });
  }

  if (content.length > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Content too large (max 1MB)" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
    const safeFilePath = filePath.replace(/^\//, "");
    const fullPath = path.join(repoDir, safeFilePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoDir))) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    fs.writeFileSync(fullPath, content, "utf-8");
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to write file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
