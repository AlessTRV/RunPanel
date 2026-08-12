import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import yauzl from "yauzl";
import { isSafeEntryPath, openArchive } from "./backup/archive-read";

/**
 * Unpacking a project ZIP the operator uploaded.
 *
 * This used to shell out to `tar -xf`, with `Expand-Archive` as a fallback.
 * Both extract; neither is a policy. What that arrangement actually meant:
 *
 *  - zip-slip was refused by GNU tar rather than by this codebase, and the
 *    PowerShell fallback has historically not refused it at all;
 *  - `tar` recreates symlinks, so an uploaded archive could plant a link that
 *    the file manager would later read or write straight through — the panel's
 *    own backup export already refuses to follow links for exactly this reason;
 *  - nothing bounded the uncompressed size, so a few megabytes of zip could
 *    fill the disk.
 *
 * Doing it in-process costs a dependency that was already here (`yauzl`, used
 * by the restore path) and puts all three rules in one readable place.
 */

/** Generous for source, far below what a compression bomb needs to hurt. */
const MAX_TOTAL_BYTES = 1024 ** 3;
const MAX_ENTRIES = 50_000;

export interface ExtractResult {
  files: number;
  bytes: number;
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error(`Voce illeggibile: ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

/**
 * True for an entry whose mode marks it as a symlink.
 *
 * The Unix mode lives in the high half of the external attributes, and is 0 for
 * archives written on Windows — which is why the check is "is a link", not
 * "is a regular file": the latter would reject every entry of a perfectly
 * ordinary Windows zip.
 */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = entry.externalFileAttributes >>> 16;
  return (mode & 0o170000) === 0o120000;
}

export async function extractProjectArchive(
  zipPath: string,
  destDir: string
): Promise<ExtractResult> {
  // `validateEntrySizes` is on by default, so a member that does not produce
  // the number of bytes its header promised fails the stream rather than
  // quietly writing something else.
  const zip = await openArchive(zipPath);

  let files = 0;
  let seen = 0;
  let bytes = 0;

  const handleEntry = async (entry: yauzl.Entry) => {
    if (++seen > MAX_ENTRIES) {
      throw new Error(`L'archivio contiene più di ${MAX_ENTRIES} voci`);
    }

    const name = entry.fileName;
    if (!isSafeEntryPath(name)) {
      throw new Error(`Voce non consentita nell'archivio: ${name}`);
    }
    if (isSymlinkEntry(entry)) {
      throw new Error(`Collegamento simbolico non consentito nell'archivio: ${name}`);
    }

    const target = path.join(destDir, name);

    if (name.endsWith("/")) {
      await fs.promises.mkdir(target, { recursive: true });
      return;
    }

    bytes += entry.uncompressedSize;
    if (bytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `L'archivio supera ${Math.round(MAX_TOTAL_BYTES / 1024 ** 2)} MB una volta decompresso`
      );
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(target));
    files++;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        handleEntry(entry)
          .then(() => zip.readEntry())
          .catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  return { files, bytes };
}
