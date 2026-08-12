import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";

/**
 * The streaming exec primitive, driven with `node` as the command so the checks
 * need neither a server nor a Docker daemon.
 *
 * What is worth testing here is not the happy path — it is every way the thing
 * can look like it worked and not have. A dump larger than the old 16 MB
 * buffer, a command that exits 0 having written nothing, a command that dies
 * while we are still feeding it, and one that simply hangs.
 */
export const meta = { name: "stream-exec", needsDocker: false, drivers: [], standalone: true };

const node = process.execPath;

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function run({ repoRoot }) {
  const r = createReporter("stream-exec");

  const { execToFile, execFromFile, ExecStreamError } = await import(
    pathToFileURL(join(repoRoot, "services", "stream-exec.ts")).href
  );

  const dir = fs.mkdtempSync(join(os.tmpdir(), "rp-stream-"));
  const at = (name) => join(dir, name);

  try {
    // --- past the buffer that used to be the ceiling -------------------------
    // 50 MB through a path whose predecessor gave up at 16 MB. Written with a
    // drain loop so the child does not just buffer it all and hide the point.
    const big = at("big.bin");
    const producer =
      "const b=Buffer.alloc(1<<20,7);let n=0;" +
      "function w(){while(n<50){n++;if(!process.stdout.write(b))return process.stdout.once('drain',w);}}w();";
    const bigResult = await execToFile(node, ["-e", producer], big);

    const bigBytes = fs.statSync(big).size;
    r.check("50 MB streamed to disk", bigBytes === 50 << 20, `${bigBytes} bytes`);
    r.check("reported size matches the file", bigResult.bytes === bigBytes, `${bigResult.bytes}`);
    r.check(
      "reported digest matches the file",
      bigResult.sha256 === sha256File(big),
      bigResult.sha256.slice(0, 16)
    );

    // --- compression --------------------------------------------------------
    const gz = at("payload.gz");
    const payload = "riga uno\nriga due\n".repeat(1000);
    const gzResult = await execToFile(
      node,
      ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
      gz,
      { compress: true }
    );
    const roundTripped = zlib.gunzipSync(fs.readFileSync(gz)).toString();
    r.check("gzip round-trips unchanged", roundTripped === payload, `${roundTripped.length} chars`);
    r.check(
      "raw size is recorded before compression",
      gzResult.rawBytes === Buffer.byteLength(payload) && gzResult.bytes < gzResult.rawBytes,
      `${gzResult.rawBytes} raw / ${gzResult.bytes} stored`
    );
    r.check(
      "digest is of the stored bytes, so sha256sum agrees",
      gzResult.sha256 === sha256File(gz)
    );

    // --- a command that fails ------------------------------------------------
    const failed = at("failed.bin");
    let failure = null;
    try {
      await execToFile(
        node,
        ["-e", "process.stdout.write('partial');process.stderr.write('boom\\n');process.exit(3)"],
        failed
      );
    } catch (err) {
      failure = err;
    }
    r.check("a non-zero exit rejects", failure instanceof ExecStreamError, String(failure));
    r.check("the exit code is reported", failure?.exitCode === 3, String(failure?.exitCode));
    r.check("stderr survives in the error", (failure?.stderr ?? "").includes("boom"), failure?.stderr);
    r.check(
      "the half-written file is removed, not left looking valid",
      !fs.existsSync(failed)
    );

    // --- exited 0, wrote nothing --------------------------------------------
    // The silent failure this whole guard exists for: an entrypoint that eats
    // the error leaves a clean exit code and an empty dump.
    const empty = at("empty.bin");
    let emptyFailure = null;
    try {
      await execToFile(node, ["-e", ""], empty);
    } catch (err) {
      emptyFailure = err;
    }
    r.check(
      "a clean exit with no output is still a failure",
      emptyFailure instanceof ExecStreamError,
      String(emptyFailure)
    );
    r.check("no empty artifact is left behind", !fs.existsSync(empty));

    const allowed = at("allowed.bin");
    const allowedResult = await execToFile(node, ["-e", ""], allowed, { allowEmpty: true });
    r.check(
      "allowEmpty accepts it when the caller means to",
      allowedResult.bytes === 0 && fs.existsSync(allowed)
    );

    // --- a command that hangs ------------------------------------------------
    const hung = at("hung.bin");
    const startedAt = Date.now();
    let hungFailure = null;
    try {
      await execToFile(node, ["-e", "setTimeout(()=>{},60000)"], hung, { inactivityMs: 1000 });
    } catch (err) {
      hungFailure = err;
    }
    const waited = Date.now() - startedAt;
    r.check("a silent command is killed", hungFailure instanceof ExecStreamError, String(hungFailure));
    r.check("it is killed promptly, not after the full 60s", waited < 15_000, `${waited}ms`);
    r.check("the message names the reason", /No output for/.test(hungFailure?.message ?? ""), hungFailure?.message);

    // --- stdin direction -----------------------------------------------------
    const input = at("input.txt");
    fs.writeFileSync(input, payload);
    const consumed = await execFromFile(
      node,
      ["-e", "let n=0;process.stdin.on('data',c=>n+=c.length).on('end',()=>console.log(n))"],
      input
    );
    r.check(
      "stdin reaches the command whole",
      consumed.stdoutTail.trim() === String(Buffer.byteLength(payload)),
      consumed.stdoutTail
    );

    const gzInput = at("input.gz");
    fs.writeFileSync(gzInput, zlib.gzipSync(payload));
    const decompressed = await execFromFile(
      node,
      ["-e", "let n=0;process.stdin.on('data',c=>n+=c.length).on('end',()=>console.log(n))"],
      gzInput,
      { decompress: true }
    );
    r.check(
      "decompress feeds the original bytes",
      decompressed.stdoutTail.trim() === String(Buffer.byteLength(payload)),
      decompressed.stdoutTail
    );

    // --- the command dies while we are still writing -------------------------
    // stdin then errors with EPIPE, which explains nothing. The exit code and
    // stderr are what the operator needs, so they have to win.
    let epipeFailure = null;
    try {
      await execFromFile(
        node,
        ["-e", "process.stderr.write('rifiutato\\n');process.exit(2)"],
        big
      );
    } catch (err) {
      epipeFailure = err;
    }
    r.check("an early exit rejects", epipeFailure instanceof ExecStreamError, String(epipeFailure));
    r.check(
      "the command's own reason wins over EPIPE",
      (epipeFailure?.message ?? "").includes("rifiutato"),
      epipeFailure?.message
    );
    r.check("the exit code is reported", epipeFailure?.exitCode === 2, String(epipeFailure?.exitCode));

    // --- a command that is not there -----------------------------------------
    let missing = null;
    try {
      await execToFile("runpanel-non-esiste", [], at("nope.bin"));
    } catch (err) {
      missing = err;
    }
    r.check(
      "a missing binary says so rather than hanging",
      missing instanceof ExecStreamError && /could not be executed/.test(missing.message),
      missing?.message
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
