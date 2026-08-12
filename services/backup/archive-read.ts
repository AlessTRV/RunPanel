import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import yauzl from "yauzl";
import type { BackupManifest } from "./types";

/**
 * Reading an archive back.
 *
 * Only the restore path needs this, and only for archives that were uploaded:
 * a run in the catalogue has its manifest written beside it precisely so that
 * listing what is inside never has to open a zip.
 *
 * Every entry name is treated as hostile. A zip is a list of paths chosen by
 * whoever built it, and `../../.ssh/authorized_keys` is a perfectly legal one —
 * the classic zip-slip. Names are rejected before they are joined, not after.
 */

export interface ArchiveEntry {
  entryPath: string;
  bytes: number;
  /** 0 = stored, 8 = deflated. Already-compressed members should read 0. */
  compressionMethod: number;
}

export function openArchive(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error("Archivio illeggibile"));
      else resolve(zipfile);
    });
  });
}

/** True for a name that is safe to turn into a path under a destination root. */
export function isSafeEntryPath(name: string): boolean {
  if (!name || name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.includes("\\")) return false;
  if (name.split("/").some((part) => part === "..")) return false;
  // A NUL truncates the name for whatever consumes it next.
  if (name.includes("\0")) return false;
  return true;
}

export async function listArchiveEntries(file: string): Promise<ArchiveEntry[]> {
  const zip = await openArchive(file);
  const entries: ArchiveEntry[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith("/")) {
          entries.push({
            entryPath: entry.fileName,
            bytes: entry.uncompressedSize,
            compressionMethod: entry.compressionMethod,
          });
        }
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  return entries;
}

function findEntry(file: string, wanted: string): Promise<{ zip: yauzl.ZipFile; entry: yauzl.Entry } | null> {
  return openArchive(file).then(
    (zip) =>
      new Promise<{ zip: yauzl.ZipFile; entry: yauzl.Entry } | null>((resolve, reject) => {
        let found = false;
        zip.on("entry", (entry: yauzl.Entry) => {
          if (entry.fileName === wanted) {
            found = true;
            resolve({ zip, entry });
          } else {
            zip.readEntry();
          }
        });
        zip.on("end", () => {
          if (!found) {
            zip.close();
            resolve(null);
          }
        });
        zip.on("error", (err) => {
          zip.close();
          reject(err);
        });
        zip.readEntry();
      })
  );
}

/** A stream over one member. The caller must consume it; the handle closes after. */
export async function openArchiveEntry(file: string, entryPath: string): Promise<Readable> {
  const match = await findEntry(file, entryPath);
  if (!match) throw new Error(`L'archivio non contiene ${entryPath}`);

  return new Promise<Readable>((resolve, reject) => {
    match.zip.openReadStream(match.entry, (err, stream) => {
      if (err || !stream) {
        match.zip.close();
        reject(err ?? new Error(`Impossibile leggere ${entryPath}`));
        return;
      }
      stream.on("end", () => match.zip.close());
      stream.on("error", () => match.zip.close());
      resolve(stream);
    });
  });
}

/** Extract one member to a path chosen by us, never by the archive. */
export async function extractArchiveEntry(
  file: string,
  entryPath: string,
  destination: string
): Promise<number> {
  if (!isSafeEntryPath(entryPath)) {
    throw new Error(`Nome di file rifiutato nell'archivio: ${entryPath}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const source = await openArchiveEntry(file, entryPath);
  await pipeline(source, fs.createWriteStream(destination, { mode: 0o600 }));
  return fs.statSync(destination).size;
}

export async function readArchiveManifest(file: string): Promise<BackupManifest | null> {
  let stream: Readable;
  try {
    stream = await openArchiveEntry(file, "manifest.json");
  } catch {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as BackupManifest;
  } catch {
    return null;
  }
}
