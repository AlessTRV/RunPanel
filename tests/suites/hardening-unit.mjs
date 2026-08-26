import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The containment checks, held against the two ways they were got round.
 *
 * Both are the kind of bug that reads as correct: a path that resolves inside
 * the project, and a contract field that looks like build configuration. What
 * makes them worth a suite of their own is that neither is visible from the
 * behaviour of the panel — a deploy that quietly wrote outside its directory
 * looked exactly like one that did not.
 */
export const meta = { name: "hardening-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("hardening-unit");

  const fsSafe = await import(pathToFileURL(join(repoRoot, "lib", "fs-safe.ts")).href);
  const contract = await import(pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href);
  const { resolveInside } = fsSafe;
  const { stripPanelOnlyFields, resolveContract, escapesCheckout, preflight } = contract;

  // --- resolveInside, against a symlink ---------------------------------------
  const base = mkdtempSync(join(tmpdir(), "runpanel-fs-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "runpanel-outside-"));

  try {
    mkdirSync(join(base, "app"), { recursive: true });

    // The ordinary case still works: a file that does not exist yet resolves to
    // where it would be written.
    const plain = resolveInside(base, "app/.env");
    r.check("a missing file resolves inside the base", plain === join(base, "app", ".env"), String(plain));

    r.check("a traversal is refused", resolveInside(base, "../escape") === null, "..");
    r.check("an absolute path is read as project-relative", resolveInside(base, "/app/.env") === join(base, "app", ".env"), String(resolveInside(base, "/app/.env")));

    // A LIVE link out of the base was already refused.
    const livePath = join(outside, "live.txt");
    writeFileSync(livePath, "hello");
    let liveLinked = false;
    try {
      symlinkSync(livePath, join(base, "live-link"));
      liveLinked = true;
    } catch {
      r.note("symlink not permitted on this machine — link cases skipped");
    }
    if (liveLinked) {
      r.check("a live link out of the base is refused", resolveInside(base, "live-link") === null, String(resolveInside(base, "live-link")));
    }

    /*
      And the one that got through. `fs.existsSync` follows the link and finds
      nothing, so a DANGLING link answered false, counted as a missing file, and
      had its own name re-attached to a resolved parent — which is inside the
      base, so containment passed. The write that followed created the link's
      target, outside.
    */
    const danglingTarget = join(outside, "not-there-yet.txt");
    let danglingLinked = false;
    try {
      symlinkSync(danglingTarget, join(base, "dangling"));
      danglingLinked = true;
    } catch {
      /* covered by the note above */
    }

    if (danglingLinked) {
      const resolved = resolveInside(base, "dangling");
      r.check("a DANGLING link out of the base is refused", resolved === null, String(resolved));
      r.check("and nothing was created through it", !existsSync(danglingTarget), danglingTarget);

      // The same trick one level up: a dangling link as an intermediate segment.
      const nested = resolveInside(base, "dangling/child.txt");
      r.check("a dangling link as a parent segment is refused", nested === null, String(nested));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  // --- what a repository may not declare --------------------------------------
  const hostile = {
    version: 1,
    docker: { context: "../..", dockerfile: "../../Dockerfile", target: "x", network: "host", mounts: ["/:/host"] },
    healthcheck: { path: "@evil.tld/", port: 22 },
    envFile: { path: "/etc/passwd" },
    commands: { build: "npm run build" },
  };

  const stripped = stripPanelOnlyFields(hostile);
  for (const field of [
    "docker.context",
    "docker.dockerfile",
    "docker.target",
    "docker.network",
    "docker.mounts",
    "healthcheck.path",
    "healthcheck.port",
    "envFile.path",
  ]) {
    r.check(`${field} is stripped from a repository contract`, stripped.rejected.includes(field), stripped.rejected.join(", "));
  }

  // Build instructions are the repository's own business and must survive.
  r.check(
    "commands.build survives the strip",
    stripped.contract.commands?.build === "npm run build",
    JSON.stringify(stripped.contract.commands)
  );

  // And the merge must not let them back in by the side door.
  const merged = resolveContract({}, stripped.contract);
  r.check("the merged contract keeps the default context", merged.docker.context === ".", merged.docker.context);
  r.check("the merged contract keeps the default probe path", merged.healthcheck.path === "/", merged.healthcheck.path);
  r.check("the merged contract has no repo-chosen dockerfile", merged.docker.dockerfile === undefined, String(merged.docker.dockerfile));

  // --- the textual half of the same rule --------------------------------------
  for (const [what, value, expected] of [
    ["a plain relative path", "docker/api", false],
    ["a dot", ".", false],
    ["a subdirectory", "./services/api", false],
    ["a traversal", "../..", true],
    ["a traversal in the middle", "a/../../b", true],
    ["an absolute posix path", "/etc", true],
    ["a windows drive", "C:/Windows", true],
  ]) {
    r.check(`escapesCheckout: ${what}`, escapesCheckout(value) === expected, `${value} -> ${escapesCheckout(value)}`);
  }

  // preflight has to say so too, because that is where an operator reads it
  // before a ten-minute build finds out.
  // `version: 1` matters: without it `normalizeRaw` reads the object as the
  // legacy four-field shape and strips everything it does not recognise.
  const issues = preflight(
    resolveContract({ version: 1, docker: { context: "../.." } }, {}),
    { runtimeType: "docker", envVars: {} }
  );
  r.check(
    "preflight names an escaping build context",
    issues.some((issue) => issue.field === "docker.context"),
    JSON.stringify(issues)
  );

  return r.result();
}
