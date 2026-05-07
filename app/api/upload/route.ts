import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { config } from "@/lib/config";
import { isValidSlug } from "@/lib/utils";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const projectSlug = formData.get("projectSlug") as string | null;

  if (!file || !projectSlug) {
    return NextResponse.json(
      { error: "File and projectSlug are required" },
      { status: 400 }
    );
  }

  // Validate slug to prevent path traversal
  if (!isValidSlug(projectSlug)) {
    return NextResponse.json(
      { error: "Invalid project slug" },
      { status: 400 }
    );
  }

  if (!file.name.endsWith(".zip")) {
    return NextResponse.json(
      { error: "Only ZIP files are supported" },
      { status: 400 }
    );
  }

  // Validate ZIP magic bytes (PK\x03\x04)
  const header = Buffer.from(await file.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x50 || header[1] !== 0x4B || header[2] !== 0x03 || header[3] !== 0x04) {
    return NextResponse.json(
      { error: "File is not a valid ZIP archive" },
      { status: 400 }
    );
  }

  // Max 100MB
  if (file.size > 100 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File too large (max 100MB)" },
      { status: 400 }
    );
  }

  const uploadDir = config.uploadsDir;
  const zipPath = path.join(uploadDir, `${projectSlug}.zip`);
  const destDir = path.join(config.reposDir, projectSlug);

  // Save zip
  const bytes = await file.arrayBuffer();
  fs.writeFileSync(zipPath, Buffer.from(bytes));

  // Extract
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  try {
    // Try using tar (available on modern Windows and Linux)
    await exec("tar", ["-xf", zipPath, "-C", destDir], { timeout: 60_000 });
  } catch {
    // Fallback: try powershell on Windows
    try {
      await exec("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
      ], { timeout: 60_000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Extraction failed";
      return NextResponse.json(
        { error: `Failed to extract ZIP: ${message}` },
        { status: 500 }
      );
    }
  }

  // Check if zip extracted into a single subfolder
  const entries = fs.readdirSync(destDir);
  if (entries.length === 1) {
    const singleDir = path.join(destDir, entries[0]);
    if (fs.statSync(singleDir).isDirectory()) {
      // Move contents up one level
      const subEntries = fs.readdirSync(singleDir);
      for (const entry of subEntries) {
        fs.renameSync(path.join(singleDir, entry), path.join(destDir, entry));
      }
      fs.rmdirSync(singleDir);
    }
  }

  // Clean up zip
  fs.unlinkSync(zipPath);

  return NextResponse.json({ success: true, path: destDir });
}
