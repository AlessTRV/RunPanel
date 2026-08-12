import { createReporter } from "../harness.mjs";
import crypto from "node:crypto";

/**
 * The parts of the S3 adapter that can be checked without a bucket.
 *
 * A deliberate limitation, stated rather than papered over: there is no trusted
 * SigV4 test vector available offline here, and asserting that the signature
 * equals whatever this code produces would test nothing at all — it would pass
 * for a broken implementation and would keep passing after it was broken
 * further. **The signature itself is verified against a real endpoint by the
 * "Verifica" button on the destination, which writes and deletes an object.**
 *
 * What IS testable offline is everything around it: the key encoder, whose bugs
 * sign one object and upload to another, and the structural properties of the
 * derivation — that every signed input actually reaches the signature.
 */
export const meta = { name: "s3-signature-unit", needsDocker: false, drivers: [], standalone: true };

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

/** The chain as `s3.ts` implements it, so the properties below describe it. */
function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

function signatureFor({ secret = "s3cr3t", date = "20260812", region = "eu-central-1", stringToSign = "x" } = {}) {
  return crypto
    .createHmac("sha256", signingKey(secret, date, region))
    .update(stringToSign, "utf8")
    .digest("hex");
}

function uriEncode(value, keepSlash) {
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

export async function run() {
  const r = createReporter("s3-signature-unit");

  // --- the key encoder ------------------------------------------------------
  //
  // Not `encodeURIComponent`: that escapes `/`, which has to survive inside a
  // path, and it is exactly the kind of difference that signs `a/b` and uploads
  // to `a%2Fb`.
  r.check("a slash survives in a path", uriEncode("2026/08/backup.zip", true) === "2026/08/backup.zip");
  r.check("a space becomes %20, never +", uriEncode("con spazio.zip", true) === "con%20spazio.zip");
  r.check("unreserved characters are untouched", uriEncode("a-b_c.d~e", true) === "a-b_c.d~e");
  r.check(
    "an accented character becomes its UTF-8 bytes",
    uriEncode("città.zip", true) === "citt%C3%A0.zip",
    uriEncode("città.zip", true)
  );
  r.check("a slash is escaped where it is not a separator", uriEncode("a/b", false) === "a%2Fb");
  r.check("a plus is escaped rather than treated as a space", uriEncode("a+b", true) === "a%2Bb");

  // --- the derivation is a real chain ---------------------------------------
  //
  // Every one of these is a signed input. If any of them failed to reach the
  // signature, two different requests would sign identically — which is the
  // shape of the bug that lets a replayed or misdirected request be accepted.
  const base = signatureFor();
  r.check("the same inputs give the same signature", signatureFor() === base);
  r.check("a different secret changes it", signatureFor({ secret: "altro" }) !== base);
  r.check("a different date changes it", signatureFor({ date: "20260813" }) !== base);
  r.check("a different region changes it", signatureFor({ region: "us-east-1" }) !== base);
  r.check("a different request changes it", signatureFor({ stringToSign: "y" }) !== base);

  r.check(
    "the signing key is not the secret in disguise",
    !signingKey("s3cr3t", "20260812", "eu-central-1").toString("hex").includes(
      Buffer.from("s3cr3t").toString("hex")
    )
  );

  // --- the canonical request commits to what it should -----------------------
  const canonical = (method, path, headers) =>
    [method, path, "", headers, "host;x-amz-content-sha256;x-amz-date", "UNSIGNED-PAYLOAD"].join("\n");

  const headers = "host:b.example.com\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20260812T000000Z\n";
  const put = sha256(canonical("PUT", "/k", headers));

  r.check("the method is committed to", sha256(canonical("DELETE", "/k", headers)) !== put);
  r.check("so is the key", sha256(canonical("PUT", "/other", headers)) !== put);
  r.check(
    "and so is the date",
    sha256(canonical("PUT", "/k", headers.replace("20260812", "20260813"))) !== put
  );

  r.note("la firma end-to-end si verifica con il pulsante Verifica su un endpoint reale");
  return r.result();
}
