import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { isValidSlug } from "@/lib/utils";
import { extractProjectArchive } from "@/services/project-archive";
import fs from "fs";
import path from "path";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  // Checked before `formData()`, which reads the whole body into memory. A
  // declared length is not proof, but it turns the obvious case into a cheap
  // refusal instead of a 2 GB allocation.
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declaredLength > MAX_UPLOAD_BYTES * 1.1) {
    return NextResponse.json({ error: "File too large (max 100MB)" }, { status: 413 });
  }

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
      { error: "Slug del progetto non valido" },
      { status: 400 }
    );
  }

  // A well-formed slug that belongs to no project is still a directory under
  // `repos/`, and the extraction below starts by deleting it. Without this, a
  // typo — or a guess — wiped another project's checkout.
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("slug", "=", projectSlug)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  if (!file.name.endsWith(".zip")) {
    return NextResponse.json(
      { error: "Sono accettati solo file ZIP" },
      { status: 400 }
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 100MB)" },
      { status: 400 }
    );
  }

  // Validate ZIP magic bytes (PK\x03\x04)
  const header = Buffer.from(await file.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
    return NextResponse.json(
      { error: "File is not a valid ZIP archive" },
      { status: 400 }
    );
  }

  const zipPath = path.join(config.uploadsDir, `${projectSlug}.zip`);
  const destDir = path.join(config.reposDir, projectSlug);

  await fs.promises.mkdir(config.uploadsDir, { recursive: true });
  await fs.promises.writeFile(zipPath, Buffer.from(await file.arrayBuffer()));

  try {
    await fs.promises.rm(destDir, { recursive: true, force: true });
    await fs.promises.mkdir(destDir, { recursive: true });

    // Entry names, symlinks and the decompressed total are all checked here
    // rather than left to whichever extractor happened to be on the host.
    await extractProjectArchive(zipPath, destDir);
    await flattenSingleRoot(destDir);

    return NextResponse.json({ success: true, path: destDir });
  } catch (err: unknown) {
    // A rejected archive leaves a half-written tree behind, and the next deploy
    // would build it.
    await fs.promises.rm(destDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : "Extraction failed";
    return NextResponse.json({ error: `Failed to extract ZIP: ${message}` }, { status: 400 });
  } finally {
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
  }
}

/**
 * A zip made from a folder unpacks as `project-main/…`. Lift that one level so
 * the repo root is where every builder expects it.
 */
async function flattenSingleRoot(destDir: string): Promise<void> {
  const entries = await fs.promises.readdir(destDir, { withFileTypes: true });
  const only = entries.length === 1 ? entries[0] : null;
  if (!only?.isDirectory()) return;

  const nested = path.join(destDir, only.name);
  for (const entry of await fs.promises.readdir(nested)) {
    await fs.promises.rename(path.join(nested, entry), path.join(destDir, entry));
  }
  await fs.promises.rmdir(nested);
}
