import crypto from "crypto";
import fs from "fs";
import { Readable } from "stream";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import type { Destination } from "../types";

/**
 * Backups to S3-compatible object storage.
 *
 * The `Destination` interface was written as the seam for exactly this and then
 * only ever had `local` behind it — which meant every archive lived on the same
 * disk as the thing it was protecting. A backup that dies with the machine is
 * a copy, not a backup.
 *
 * One adapter covers S3, Cloudflare R2, Backblaze B2, MinIO and every other
 * implementation of the same API, because they differ in endpoint and in
 * addressing style, not in protocol.
 *
 * No SDK. The five operations this interface needs are plain HTTPS requests,
 * and SigV4 is a documented HMAC chain over `node:crypto` — about eighty lines,
 * against a dependency tree measured in megabytes that would also have to be
 * kept current. The panel already refuses to vendor what it can state.
 */

export interface S3Config {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, … */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, without leading or trailing slashes. */
  prefix?: string;
  /**
   * `https://s3.example.com/bucket/key` instead of `https://bucket.s3.example.com/key`.
   * MinIO and most self-hosted implementations need it; R2 accepts either.
   */
  forcePathStyle?: boolean;
}

const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

function sha256(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** Percent-encoding as S3 wants it: unreserved characters only, `/` kept in paths. */
function uriEncode(value: string, keepSlash: boolean): string {
  return value
    .split("")
    .map((ch) => {
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      if (ch === "/" && keepSlash) return ch;
      return Array.from(Buffer.from(ch, "utf8"))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign one request with AWS Signature Version 4.
 *
 * The payload hash is `UNSIGNED-PAYLOAD` rather than the real digest. That is
 * the documented option for streamed uploads over HTTPS, and here it is the
 * difference between reading a multi-gigabyte archive twice — once to hash it,
 * once to send it — and reading it once. TLS is what protects the body; the
 * signature still covers the method, path, query and headers.
 */
function sign(
  config: S3Config,
  method: string,
  key: string,
  extraHeaders: Record<string, string> = {}
): SignedRequest {
  const endpoint = new URL(config.endpoint);
  const encodedKey = uriEncode(key, true);

  const pathStyle = config.forcePathStyle ?? false;
  const host = pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = pathStyle ? `/${config.bucket}/${encodedKey}` : `/${encodedKey}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };

  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames
    .map((name) => {
      const value = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
      return `${name}:${String(value).trim()}\n`;
    })
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), SERVICE),
    "aws4_request"
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: `${endpoint.protocol}//${host}${path}`, headers };
}

/** The archive's key in the bucket, prefix included. */
function objectKey(config: S3Config, fileName: string): string {
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${fileName}` : fileName;
}

function isValid(config: Partial<S3Config>): config is S3Config {
  return Boolean(
    config.endpoint && config.region && config.bucket && config.accessKeyId && config.secretAccessKey
  );
}

export function s3Destination(
  row: BackupDestinationsTable,
  raw: Record<string, unknown>
): Destination {
  const config = raw as unknown as Partial<S3Config>;

  function requireConfig(): S3Config {
    if (!isValid(config)) {
      throw new Error(
        "Configurazione S3 incompleta: servono endpoint, region, bucket e le credenziali."
      );
    }
    return config;
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath, fileName) {
      const cfg = requireConfig();
      const { size } = await fs.promises.stat(localPath);
      const key = objectKey(cfg, fileName);

      const { url, headers } = sign(cfg, "PUT", key, {
        "content-length": String(size),
        "content-type": "application/zip",
      });

      const res = await fetch(url, {
        method: "PUT",
        headers,
        // Streamed, not buffered: an archive is routinely larger than the heap.
        body: Readable.toWeb(fs.createReadStream(localPath)) as ReadableStream,
        // Required by undici whenever the body is a stream.
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      if (!res.ok) {
        throw new Error(`Upload su S3 non riuscito (${res.status}): ${await res.text()}`);
      }

      return { ref: key, bytes: size };
    },

    async remove(ref) {
      const cfg = requireConfig();
      const { url, headers } = sign(cfg, "DELETE", ref);
      const res = await fetch(url, { method: "DELETE", headers });
      // 404 means the object is already gone, which is the state we wanted.
      if (!res.ok && res.status !== 404) {
        throw new Error(`Eliminazione su S3 non riuscita (${res.status})`);
      }
    },

    async open(ref): Promise<Readable> {
      const cfg = requireConfig();
      const { url, headers } = sign(cfg, "GET", ref);
      const res = await fetch(url, { headers });
      if (!res.ok || !res.body) {
        throw new Error(`Lettura da S3 non riuscita (${res.status})`);
      }
      return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    },

    async stat(ref) {
      const cfg = requireConfig();
      const { url, headers } = sign(cfg, "HEAD", ref);
      const res = await fetch(url, { method: "HEAD", headers });
      if (res.status === 404) return { bytes: 0, exists: false };
      if (!res.ok) throw new Error(`HEAD su S3 non riuscita (${res.status})`);
      return { bytes: Number(res.headers.get("content-length") ?? 0), exists: true };
    },

    /**
     * Writes and deletes a marker rather than only listing.
     *
     * A read-only key passes any check that just looks, and then fails on the
     * night of the first scheduled backup. The point of this button is to find
     * that out now.
     */
    async test() {
      let cfg: S3Config;
      try {
        cfg = requireConfig();
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Configurazione non valida" };
      }

      const key = objectKey(cfg, `.runpanel-write-test-${Date.now()}`);
      try {
        const body = Buffer.from("runpanel");
        const put = sign(cfg, "PUT", key, {
          "content-length": String(body.byteLength),
          "content-type": "text/plain",
        });
        const written = await fetch(put.url, { method: "PUT", headers: put.headers, body });
        if (!written.ok) {
          return {
            ok: false,
            message: `Scrittura rifiutata (${written.status}). Controlla credenziali, bucket e permessi.`,
          };
        }

        const del = sign(cfg, "DELETE", key);
        await fetch(del.url, { method: "DELETE", headers: del.headers });

        return { ok: true, message: `Bucket ${cfg.bucket} raggiungibile e scrivibile.` };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "Endpoint non raggiungibile",
        };
      }
    },
  };
}
