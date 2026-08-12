import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The rules that decide what untrusted input is allowed to reach.
 *
 * Every check here failed before the hardening pass, and each one corresponds
 * to a way in that was real rather than theoretical.
 */
export const meta = { name: "security-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("security-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  // --- the repository may not grant itself the host ------------------------
  const { stripPanelOnlyFields, resolveContract } = await load("lib", "deploy-contract.ts");

  const hostile = {
    commands: { install: "npm ci" },
    docker: { image: "node:20", mounts: ["/:/host"], capAdd: ["SYS_ADMIN"], network: "host" },
    envFile: { enabled: true, path: "../elsewhere/.env" },
  };

  const stripped = stripPanelOnlyFields(hostile);
  r.check(
    "a repo contract cannot set docker.mounts",
    stripped.contract.docker.mounts === undefined,
    JSON.stringify(stripped.contract.docker)
  );
  r.check("a repo contract cannot set docker.capAdd", stripped.contract.docker.capAdd === undefined);
  r.check("a repo contract cannot set docker.network", stripped.contract.docker.network === undefined);
  r.check("a repo contract cannot set envFile.path", stripped.contract.envFile.path === undefined);
  r.check(
    "what it may set survives",
    stripped.contract.commands.install === "npm ci" && stripped.contract.docker.image === "node:20"
  );
  r.check(
    "the rejected fields are named, so the deploy log can say so",
    stripped.rejected.includes("docker.mounts") && stripped.rejected.includes("envFile.path"),
    stripped.rejected.join(",")
  );

  // A project starts life with `builder_config: "{}"`, which is what made this
  // reachable by default rather than only on a misconfigured project.
  const resolved = resolveContract({}, stripped.contract);
  r.check("resolving an empty panel config yields no mounts", resolved.docker.mounts.length === 0);
  r.check("resolving an empty panel config yields no capabilities", resolved.docker.capAdd.length === 0);
  r.check("resolving an empty panel config keeps the project network", resolved.docker.network === "project");

  // --- path containment ----------------------------------------------------
  const { resolveInside, isPathShapeSafe } = await load("lib", "fs-safe.ts");

  const root = mkdtempSync(join(tmpdir(), "runpanel-fs-"));
  try {
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    writeFileSync(join(root, "repo", "src", "index.js"), "ok");
    writeFileSync(join(root, "secret.txt"), "not yours");
    const repo = join(root, "repo");

    r.check("a normal path resolves", resolveInside(repo, "src/index.js") !== null);
    r.check("a path that does not exist yet still resolves", resolveInside(repo, "src/new.js") !== null);
    r.check("dot-dot is refused", resolveInside(repo, "../secret.txt") === null);
    // A leading slash means "root of the project" — the file manager sends
    // paths that way — so this must resolve INSIDE the repo, not to the
    // filesystem root.
    r.check(
      "a leading slash is anchored to the project, not the filesystem",
      resolveInside(repo, "/secret.txt") === join(repo, "secret.txt"),
      String(resolveInside(repo, "/secret.txt"))
    );
    r.check("a NUL byte is refused", resolveInside(repo, "src/\0.js") === null);

    // The sibling-prefix bug: `startsWith(base)` alone accepts this.
    mkdirSync(join(root, "repo-evil"), { recursive: true });
    writeFileSync(join(root, "repo-evil", "x.js"), "nope");
    r.check(
      "a sibling directory sharing the name prefix is refused",
      resolveInside(repo, "../repo-evil/x.js") === null
    );

    let symlinksAvailable = true;
    try {
      symlinkSync(join(root, "secret.txt"), join(repo, "link.txt"));
    } catch {
      // Windows needs Developer Mode or elevation to create one.
      symlinksAvailable = false;
    }

    if (symlinksAvailable) {
      r.check(
        "a symlink pointing outside the repo is refused",
        resolveInside(repo, "link.txt") === null
      );
    } else {
      console.log("    skip symlink containment (no permission to create symlinks here)");
    }

    r.check("shape check refuses dot-dot", !isPathShapeSafe("../x"));
    r.check("shape check refuses a drive letter", !isPathShapeSafe("C:/x"));
    r.check("shape check allows an ordinary path", isPathShapeSafe("/src/index.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // --- archive entries -----------------------------------------------------
  const { isSafeEntryPath } = await load("services", "backup", "archive-read.ts");
  r.check("zip-slip entry refused", !isSafeEntryPath("../../etc/cron.d/x"));
  r.check("absolute zip entry refused", !isSafeEntryPath("/etc/passwd"));
  r.check("windows drive zip entry refused", !isSafeEntryPath("C:\\windows\\x"));
  r.check("ordinary zip entry accepted", isSafeEntryPath("src/index.js"));

  return r.result();
}
