import { createReporter } from "../harness.mjs";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

/**
 * Where a restore reads its archive from.
 *
 * A local archive is read in place. Anything else has to be downloaded into
 * the restore's staging folder first: the S3 restore used to hand back a local
 * path that did not exist and failed on its first `stat`. Checked here with a
 * fake destination, so no bucket is needed.
 *
 * Standalone: `services/backup/archive-source.ts` imports only `node:` modules.
 */
export const meta = { name: "archive-source-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("archive-source-unit");
  const { archiveForRestore } = await import(pathToFileURL(join(repoRoot, "services", "backup", "archive-source.ts")).href);

  const staging = mkdtempSync(join(tmpdir(), "rp-archive-source-"));
  const payload = Buffer.from("PK\u0003\u0004 not really a zip, but bytes are bytes");
  const opts = (patch = {}) => ({
    bytes: payload.length,
    freeBytes: null,
    reserveBytes: 0,
    localPath: (ref) => `/data/backups/archives/${ref}`,
    ...patch,
  });
  const remote = (body) => ({ type: "s3", open: async () => Readable.from([body]) });

  try {
    {
      let opened = false;
      const local = { type: "local", open: async () => { opened = true; return Readable.from([]); } };
      const res = await archiveForRestore(local, "2026/10/a.zip", staging, opts());
      r.check("a local archive is read in place", res.file === "/data/backups/archives/2026/10/a.zip" && res.downloaded === false);
      r.check("and is not downloaded", opened === false);
    }

    {
      const res = await archiveForRestore(remote(payload), "a.zip", staging, opts());
      r.check("a remote archive lands in the staging folder", res.downloaded === true && res.file.startsWith(staging), res.file);
      r.check("with the same bytes", existsSync(res.file) && readFileSync(res.file).equals(payload));
    }

    {
      let error = null;
      try {
        await archiveForRestore(remote(payload), "a.zip", staging, opts({ freeBytes: 10, reserveBytes: 0 }));
      } catch (err) {
        error = err;
      }
      r.check("not enough free space is refused before downloading", error !== null && /Spazio/.test(error.message), String(error));
    }

    {
      const broken = {
        type: "s3",
        open: async () =>
          new Readable({
            read() {
              this.destroy(new Error("connection reset"));
            },
          }),
      };
      const dir = mkdtempSync(join(tmpdir(), "rp-archive-source-broken-"));
      let error = null;
      try {
        await archiveForRestore(broken, "a.zip", dir, opts());
      } catch (err) {
        error = err;
      }
      r.check("a failed download is reported", error !== null && /Download/.test(error.message), String(error));
      r.check("and leaves no half-written file", readdirSync(dir).length === 0, readdirSync(dir).join(", "));
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return r.result();
}
