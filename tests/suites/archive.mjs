import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";

/**
 * Writing an archive and reading it back, with nothing else involved.
 *
 * The archive is the one artifact that has to still be correct months later, on
 * a different machine, possibly without RunPanel. So the checks here are about
 * the properties that make that true: the file only appears once it is
 * complete, the checksums in it agree with the bytes, already-compressed
 * members are not compressed again, and a hostile entry name is refused rather
 * than joined onto a path.
 */
export const meta = { name: "archive", needsDocker: false, drivers: [], standalone: true };

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function run({ repoRoot }) {
  const r = createReporter("archive");

  const { writeArchive } = await import(
    pathToFileURL(join(repoRoot, "services", "backup", "archive.ts")).href
  );
  const { listArchiveEntries, readArchiveManifest, extractArchiveEntry, isSafeEntryPath } =
    await import(pathToFileURL(join(repoRoot, "services", "backup", "archive-read.ts")).href);

  const dir = fs.mkdtempSync(join(os.tmpdir(), "rp-archive-"));
  const at = (name) => join(dir, name);

  try {
    // Two members: one compressible text file, one already gzipped.
    const text = "colonna,valore\n".repeat(5000);
    const plainPath = at("dump.sql");
    fs.writeFileSync(plainPath, text);

    const gzipped = zlib.gzipSync(Buffer.from(text));
    const gzPath = at("dump.sql.gz");
    fs.writeFileSync(gzPath, gzipped);

    const files = [
      {
        absolutePath: plainPath,
        entryPath: "panel/runpanel.db",
        bytes: fs.statSync(plainPath).size,
        sha256: sha256(fs.readFileSync(plainPath)),
        precompressed: false,
      },
      {
        absolutePath: gzPath,
        entryPath: "databases/pg/all.sql.gz",
        bytes: fs.statSync(gzPath).size,
        sha256: sha256(gzipped),
        precompressed: true,
      },
    ];

    const manifest = {
      schemaVersion: 1,
      runId: "run000000001",
      policyId: null,
      policyName: "Notturno",
      trigger: "manual",
      createdAt: "2026-08-07T02:00:00.000Z",
      panel: { version: "0.1.0", storeDriver: "sqlite" },
      artifacts: files.map((file) => ({
        kind: "service-db",
        refId: null,
        refName: file.entryPath,
        entryPath: file.entryPath,
        bytes: file.bytes,
        sha256: file.sha256,
        status: "ok",
      })),
    };

    const destination = at("backup.zip");
    const result = await writeArchive(destination, files, manifest);

    // --- the file only exists once it is whole -------------------------------
    r.check("the archive is written", fs.existsSync(destination));
    r.check(
      "no .part is left behind for a reader to mistake for a backup",
      !fs.existsSync(`${destination}.part`)
    );
    r.check(
      "the reported size matches the file",
      result.bytes === fs.statSync(destination).size,
      `${result.bytes}`
    );
    r.check(
      "the reported digest matches the file",
      result.sha256 === sha256(fs.readFileSync(destination))
    );

    // --- contents ------------------------------------------------------------
    const entries = await listArchiveEntries(destination);
    const byPath = new Map(entries.map((entry) => [entry.entryPath, entry]));

    for (const expected of [
      "panel/runpanel.db",
      "databases/pg/all.sql.gz",
      "manifest.json",
      "checksums.txt",
      "LEGGIMI.txt",
    ]) {
      r.check(`contains ${expected}`, byPath.has(expected));
    }

    r.check(
      "a compressible member is deflated",
      byPath.get("panel/runpanel.db")?.compressionMethod === 8
    );
    // Compressing a gzip stream costs CPU to make the file marginally bigger.
    r.check(
      "an already-compressed member is stored, not compressed twice",
      byPath.get("databases/pg/all.sql.gz")?.compressionMethod === 0
    );

    // --- round trip ----------------------------------------------------------
    const extracted = at("extracted.sql");
    await extractArchiveEntry(destination, "panel/runpanel.db", extracted);
    r.check(
      "an extracted member is byte-identical",
      fs.readFileSync(extracted, "utf8") === text
    );

    const readBack = await readArchiveManifest(destination);
    r.check("the manifest survives the round trip", readBack?.runId === "run000000001");
    r.check("the manifest lists both artifacts", readBack?.artifacts.length === 2);

    // --- verifiable without RunPanel ----------------------------------------
    const checksums = at("checksums.txt");
    await extractArchiveEntry(destination, "checksums.txt", checksums);
    const lines = fs
      .readFileSync(checksums, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("  "));
    r.check("checksums.txt lists every member with a digest", lines.length === 2);
    r.check(
      "checksums.txt is in sha256sum's own format",
      lines.every(([digest, path]) => /^[0-9a-f]{64}$/.test(digest) && path.length > 0),
      JSON.stringify(lines[0])
    );
    r.check(
      "the digests in it are the real ones",
      lines.find(([, p]) => p === "panel/runpanel.db")?.[0] === sha256(Buffer.from(text))
    );

    // --- hostile names -------------------------------------------------------
    for (const hostile of [
      "../escape.txt",
      "a/../../escape.txt",
      "/etc/passwd",
      "C:\\Windows\\system32",
      "dir\\file.txt",
      "with\0nul",
      "",
    ]) {
      r.check(`entry name refused: ${JSON.stringify(hostile)}`, !isSafeEntryPath(hostile));
    }
    for (const fine of ["panel/runpanel.db", "a/b/c.txt", "file.txt", "..dotted/name.txt"]) {
      r.check(`entry name accepted: ${fine}`, isSafeEntryPath(fine));
    }

    let rejected = null;
    try {
      await extractArchiveEntry(destination, "../escape.txt", at("nope.txt"));
    } catch (err) {
      rejected = err;
    }
    r.check("extraction refuses a traversing name", rejected !== null, String(rejected));

    // --- an entry that is not there -----------------------------------------
    let missing = null;
    try {
      await extractArchiveEntry(destination, "databases/none.sql", at("none.sql"));
    } catch (err) {
      missing = err;
    }
    r.check("a missing member fails clearly", /non contiene/.test(missing?.message ?? ""), missing?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
