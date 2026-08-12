import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import yazl from "yazl";
import type { BackupManifest, StagedFile } from "./types";

/**
 * Writing the archive.
 *
 * Three decisions here are not stylistic:
 *
 *  - the file is written as `.zip.part` and renamed once it is complete and
 *    flushed, so an interrupted run can never leave something that looks like a
 *    finished backup;
 *  - `forceZip64Format`, because the classic format gives up at 4 GB per member
 *    or 65535 members and a project volume passes either;
 *  - members that are already compressed are stored rather than deflated,
 *    since compressing a gzip stream costs CPU to make the file slightly
 *    bigger.
 */

const README = `RunPanel — archivio di backup
=============================

Contenuto
---------
  manifest.json                  cosa c'è dentro, con dimensioni e checksum
  checksums.txt                  per verificare: sha256sum -c checksums.txt
  databases/<servizio>/...       dump dei database gestiti
  panel/                         lo store del pannello
  projects/<slug>/config.enc.json  progetto, variabili e credenziali (cifrato)
  projects/<slug>/summary.json     le stesse informazioni senza i segreti
  projects/<slug>/repo/...       copia di lavoro del repository
  projects/<slug>/volumes/...    volumi Docker, come tar compressi

Ripristino dal pannello
-----------------------
Backup › la run › Ripristina. Il pannello fa da sé un backup di sicurezza di
quello che sta per sovrascrivere, prima di toccarlo.

Ripristino a mano
-----------------
  PostgreSQL   gunzip -c databases/<s>/all.sql.gz | psql -v ON_ERROR_STOP=1 -U <utente> -d postgres
  MySQL        gunzip -c databases/<s>/all.sql.gz | mysql -u root -p
  MongoDB      mongorestore --archive=databases/<s>/all.archive.gz --gzip --drop
  Redis        servizio fermo, copiare dump.rdb in /data, rimuovere l'AOF, riavviare
  Store SQLite sostituire data/runpanel.db a pannello fermo

I segreti stanno solo in config.enc.json, cifrato in AES-256-GCM con la chiave
del pannello che ha prodotto l'archivio (data/.secret oppure RUNPANEL_SECRET).
Senza quella chiave il file non è leggibile: se l'archivio contiene anche
panel/secret.key, è perché è stato chiesto esplicitamente — trattalo come
tratteresti la password di root.
`;

export interface ArchiveResult {
  bytes: number;
  sha256: string;
  /** The final path, once the `.part` has been renamed. */
  absolutePath: string;
}

export async function writeArchive(
  destination: string,
  files: StagedFile[],
  manifest: BackupManifest
): Promise<ArchiveResult> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });

  const zip = new yazl.ZipFile();
  const seen = new Set<string>();

  for (const file of files) {
    // Two artifacts claiming the same entry would silently lose one of them.
    if (seen.has(file.entryPath)) continue;
    seen.add(file.entryPath);
    zip.addFile(file.absolutePath, file.entryPath, {
      // 0 stores the member as-is; anything already gzipped would only get
      // marginally bigger for the CPU. Level 6 rather than 9 for the rest: on a
      // host that is also running the user's applications, 9 costs triple the
      // CPU to buy a percent or two.
      //
      // Only one of `compress` and `compressionLevel` may be given — yazl
      // refuses both rather than guess which one was meant.
      compressionLevel: file.precompressed ? 0 : 6,
    });
  }

  zip.addBuffer(Buffer.from(checksumFile(files), "utf8"), "checksums.txt");
  zip.addBuffer(Buffer.from(README, "utf8"), "LEGGIMI.txt");
  // Last, because it carries every checksum above it.
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), "manifest.json");

  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const sink = fs.createWriteStream(partial, { mode: 0o600 });

  // `end()` resolves before the bytes reach the disk; the write stream closing
  // is the only honest signal that the archive is complete.
  zip.end({
    // Forced rather than left to the heuristic: the classic central directory
    // gives up at 65535 members, and a project repository passes that on its
    // own. Per-entry zip64 is decided by yazl from each file's real size.
    forceZip64Format: true,
    comment: `RunPanel backup ${manifest.runId}`,
  });
  await pipeline(zip.outputStream, digest, sink);

  // Rename is atomic, but only meaningful if the content is actually on disk.
  const fd = fs.openSync(partial, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(partial, destination);

  return { bytes, sha256: hash.digest("hex"), absolutePath: destination };
}

/**
 * `sha256sum -c` format, so the archive can be verified with the tool everyone
 * already has rather than with RunPanel. Tree entries have no individual digest
 * — the archive's own checksum covers them.
 */
function checksumFile(files: StagedFile[]): string {
  const lines = files
    .filter((file) => file.sha256)
    .map((file) => `${file.sha256}  ${file.entryPath}`);
  return `${lines.join("\n")}\n`;
}
