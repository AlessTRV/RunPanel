import fs from "fs";
import path from "path";
import crypto from "crypto";
import { decrypt, encrypt } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { formatBytes } from "@/lib/utils";
import { dockerToFile, dockerTry } from "../docker/cli";
import { listOwnedVolumes } from "../docker/volumes";
import type { RunContext, StagedFile } from "./types";

/**
 * A project's configuration, its repository and its volumes.
 *
 * The configuration is the small, indispensable part: without it an archive can
 * restore every byte of data and still not know which project it belonged to,
 * how it was built, or what its environment was.
 */

const REDACTED = "***";

/**
 * Directories that are either reproducible or already backed up elsewhere.
 * Including them by default triples the size of an archive to store a
 * `node_modules` nobody will ever restore from.
 */
const REPO_EXCLUDES = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
]);

function stage(ctx: RunContext, entryPath: string): string {
  const absolute = path.join(ctx.stagingDir, entryPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return absolute;
}

function sha256Of(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The project's rows, with every secret decrypted and the whole document then
 * re-encrypted as one blob.
 *
 * Keeping the original ciphertext would look safer and be useless: it can only
 * be read with `data/.secret`, and the day that file is gone is exactly the day
 * the backup is needed. Keeping it in clear inside a zip is not acceptable
 * either. So: one encrypted document, and a redacted twin beside it for anyone
 * who just wants to see what is in the archive.
 */
export async function exportProjectConfig(
  project: ProjectsTable,
  ctx: RunContext
): Promise<{ files: StagedFile[]; meta: Record<string, unknown> }> {
  const db = await getDb();

  const [envVars, services, deployment] = await Promise.all([
    db.selectFrom("env_vars").selectAll().where("project_id", "=", project.id).execute(),
    db.selectFrom("services").selectAll().where("project_id", "=", project.id).execute(),
    db
      .selectFrom("deployments")
      .selectAll()
      .where("project_id", "=", project.id)
      .where("status", "=", "running")
      .orderBy("started_at", "desc")
      .executeTakeFirst(),
  ]);

  const serviceIds = services.map((s) => s.id);
  const databases = serviceIds.length
    ? await db
        .selectFrom("service_databases")
        .selectAll()
        .where("service_id", "in", serviceIds)
        .execute()
    : [];

  const decoded = envVars.map((row) => ({
    key: row.key,
    value: safeDecrypt(row.value),
    createdAt: row.created_at,
  }));

  const payload = {
    schemaVersion: 1,
    project,
    envVars: decoded,
    services: services.map((service) => ({
      ...service,
      credentials: safeJson(safeDecrypt(service.credentials)),
    })),
    serviceDatabases: databases,
    // The last deployment that was actually running: it carries the start
    // command and the artifact directory, which is what restoring a project
    // without rebuilding it needs.
    lastRunningDeployment: deployment ?? null,
  };

  const encPath = stage(ctx, `projects/${project.slug}/config.enc.json`);
  fs.writeFileSync(encPath, encrypt(JSON.stringify(payload)), { mode: 0o600 });

  const summary = {
    project: { ...project, webhook_secret: REDACTED },
    envKeys: decoded.map((v) => v.key),
    services: services.map((s) => ({ id: s.id, name: s.name, type: s.type, version: s.version })),
    databases: databases.map((d) => ({ service_id: d.service_id, name: d.name })),
    note:
      "I valori sensibili stanno solo in config.enc.json, cifrato con la chiave del pannello che lo ha prodotto.",
  };
  const summaryPath = stage(ctx, `projects/${project.slug}/summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  ctx.log(`→ ${project.slug}: ${decoded.length} variabili, ${services.length} servizi`);

  return {
    files: [
      {
        absolutePath: encPath,
        entryPath: `projects/${project.slug}/config.enc.json`,
        bytes: fs.statSync(encPath).size,
        sha256: sha256Of(encPath),
        precompressed: false,
      },
      {
        absolutePath: summaryPath,
        entryPath: `projects/${project.slug}/summary.json`,
        bytes: fs.statSync(summaryPath).size,
        sha256: sha256Of(summaryPath),
        precompressed: false,
      },
    ],
    meta: {
      envVarCount: decoded.length,
      serviceCount: services.length,
      databaseCount: databases.length,
      encryptedWith: "AES-256-GCM, chiave del pannello",
    },
  };
}

function safeDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    // A value the current key cannot read is a value that is already lost;
    // recording the fact beats writing a broken blob into the archive.
    return "";
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The working copy on disk.
 *
 * Off by default, because a repository cloned from GitHub is already backed up
 * by GitHub. The exception is applied automatically: a project uploaded as a
 * ZIP has no remote copy anywhere, so it is always included.
 */
export function shouldIncludeRepo(project: ProjectsTable, requested: boolean): boolean {
  return requested || project.source_type === "upload";
}

export function projectRepoDir(slug: string): string {
  return path.join(config.reposDir, slug);
}

/**
 * Files go into the archive straight from disk — there is no staging copy and
 * no intermediate tar, so a large repository costs disk space once instead of
 * twice.
 */
export async function exportProjectRepo(
  project: ProjectsTable,
  ctx: RunContext
): Promise<{ files: StagedFile[]; meta: Record<string, unknown> }> {
  const root = projectRepoDir(project.slug);
  if (!fs.existsSync(root)) {
    throw new Error(`Nessuna copia locale del repository in ${root}`);
  }

  const files: StagedFile[] = [];
  let skipped = 0;

  const walk = (dir: string, relative: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (REPO_EXCLUDES.has(entry.name)) {
        skipped++;
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(absolute, rel);
      } else if (entry.isFile()) {
        files.push({
          absolutePath: absolute,
          entryPath: `projects/${project.slug}/repo/${rel}`,
          bytes: fs.statSync(absolute).size,
          // A tree has no single digest; the archive's own checksum covers it.
          sha256: null,
          precompressed: false,
        });
      }
      // Symlinks are deliberately not followed: a link out of the repository
      // would drag arbitrary host files into the archive.
    }
  };

  walk(root, "");

  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  ctx.log(`→ ${project.slug}: repository, ${files.length} file (${formatBytes(bytes)})`);

  return {
    files,
    meta: {
      fileCount: files.length,
      excludedDirectories: skipped,
      excludes: [...REPO_EXCLUDES],
      prefix: `projects/${project.slug}/repo/`,
    },
  };
}

/** Only volumes RunPanel labelled as this project's. Never an arbitrary name. */
export async function listProjectVolumes(slug: string): Promise<string[]> {
  const volumes = await listOwnedVolumes({ project: slug });
  return volumes.map((volume) => volume.name);
}

/**
 * Candidate images for the helper container that reads a volume, in the order
 * they are tried. A host with no registry access has neither of the first two,
 * but it always has whatever image the project itself runs on.
 */
const HELPER_IMAGES = ["alpine", "busybox"];

async function helperImage(fallback: string | null): Promise<string> {
  for (const image of [...HELPER_IMAGES, ...(fallback ? [fallback] : [])]) {
    if (await dockerTry(["image", "inspect", image], { timeout: 15_000 })) return image;
  }
  // Nothing local: pull the smallest of them rather than failing outright.
  await dockerTry(["pull", "alpine"], { timeout: 120_000 });
  return "alpine";
}

/**
 * A volume, read through a throwaway container that has it mounted read-only.
 *
 * The tar goes to stdout rather than to a bind-mounted directory: a bind mount
 * is resolved by the Docker daemon, so a panel running inside a container would
 * be handing it a path that means something entirely different there.
 */
export async function exportProjectVolume(
  project: ProjectsTable,
  volume: string,
  ctx: RunContext
): Promise<{ file: StagedFile; meta: Record<string, unknown> }> {
  const owned = await listProjectVolumes(project.slug);
  if (!owned.includes(volume)) {
    throw new Error(`Il volume "${volume}" non risulta di questo progetto`);
  }

  const image = await helperImage(null);
  const entryPath = `projects/${project.slug}/volumes/${volume}.tar.gz`;
  const destination = stage(ctx, entryPath);

  ctx.log(`→ ${project.slug}: volume ${volume}`);

  const result = await dockerToFile(
    [
      "run", "--rm",
      // Read-only, so taking a backup can never write into the volume.
      "-v", `${volume}:/from:ro`,
      "-w", "/from",
      image,
      "tar", "-cf", "-", ".",
    ],
    destination,
    { compress: true, onStderr: (line) => ctx.log(`  ${line}`), signal: ctx.signal }
  );

  const bytes = fs.statSync(destination).size;
  ctx.log(`  ${formatBytes(bytes)}`);

  return {
    file: {
      absolutePath: destination,
      entryPath,
      bytes,
      sha256: result.sha256,
      precompressed: true,
    },
    meta: {
      volume,
      helperImage: image,
      format: "tar-gzip",
      uncompressedBytes: result.rawBytes,
      restoreWith: "tar -xf - dentro il volume, a container fermo",
    },
  };
}
