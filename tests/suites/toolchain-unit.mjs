import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The PATH handed to every command the panel runs.
 *
 * This is the file that decides whether `bun i` works. Started from a login
 * shell the panel inherits a PATH with `~/.bun/bin` on it and nothing here
 * matters; started by systemd it inherits PID 1's — `/usr/local/sbin:
 * /usr/local/bin:/usr/sbin:/usr/bin:/snap/bin` — and every build exits 127 with
 * `bun: command not found` while the panel itself keeps running perfectly,
 * because its own node path is absolute in the unit. The failure looks like a
 * bad build command and is not one, which is exactly why it deserves a test
 * that runs on a laptop rather than only on a host that has been broken once.
 *
 * Standalone: `services/toolchain.ts` imports node builtins and nothing else,
 * and the directory probe is injectable, so this asserts the real logic against
 * a made-up filesystem instead of whatever the test machine happens to have.
 */
export const meta = { name: "toolchain-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("toolchain-unit");

  const { toolchainPath, whichSync } = await import(
    pathToFileURL(join(repoRoot, "services", "toolchain.ts")).href
  );

  // What systemd actually hands a unit, verbatim.
  const SYSTEMD = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin";
  const HOME = "/home/op";
  const NODE_DIR = "/home/op/.nvm/versions/node/v24.14.1/bin";

  // A host where everything the panel needs is installed per-user.
  const present = new Set([NODE_DIR, "/home/op/.bun/bin", "/home/op/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  const exists = (dir) => present.has(dir);

  const repaired = toolchainPath(SYSTEMD, HOME, NODE_DIR, exists);
  const entries = repaired.split(":");

  // --- the whole point -----------------------------------------------------
  r.check("bun's directory ends up on the PATH", entries.includes("/home/op/.bun/bin"), repaired);
  // Not a hardcoded nvm guess: it is the directory of the node running this
  // process, so it is right whatever the version number is.
  r.check("node's own directory ends up on the PATH", entries.includes(NODE_DIR), repaired);

  // --- what must not change ------------------------------------------------
  // An operator who set a PATH meant it; repairing must add, never reorder.
  r.check(
    "the inherited PATH survives in its original order, at the front",
    repaired.startsWith(SYSTEMD),
    repaired
  );
  r.check(
    "nothing appears twice",
    new Set(entries).size === entries.length,
    entries.filter((e, i) => entries.indexOf(e) !== i).join(", ") || "(no duplicates)"
  );
  // A directory that is not there only slows every lookup down.
  r.check(
    "directories that do not exist are left out",
    !entries.includes("/home/op/.cargo/bin") && !entries.includes("/home/op/.deno/bin"),
    repaired
  );
  // /usr/local/bin is already in systemd's PATH — it must not be appended again
  // just because it is also in the fallback list.
  r.check(
    "an entry already inherited is not appended a second time",
    entries.filter((e) => e === "/usr/local/bin").length === 1
  );

  // --- the degenerate cases ------------------------------------------------
  // cron gives a two-entry PATH; a raw `execve` can give none at all.
  const fromNothing = toolchainPath("", HOME, NODE_DIR, exists).split(":");
  r.check(
    "an empty inherited PATH still yields a usable one",
    fromNothing.includes(NODE_DIR) && fromNothing.includes("/home/op/.bun/bin") && fromNothing.includes("/usr/bin"),
    fromNothing.join(":")
  );
  r.check(
    "no empty entries, which would mean the current directory",
    !toolchainPath("/usr/bin::/bin", HOME, NODE_DIR, exists).split(":").includes("")
  );

  // --- whichSync -----------------------------------------------------------
  // Resolving to an absolute path once is what lets the pm2 driver stop relying
  // on `npx --no-install`, which searches node_modules and its own cache but
  // never PATH — so a `bun add -g pm2` was invisible to it.
  const node = whichSync("node", process.env.PATH || "");
  r.check("it finds a binary that is certainly installed", node !== null, String(node));
  r.check(
    "it returns an absolute path, not a name",
    node === null || node.startsWith("/") || /^[A-Za-z]:\\/.test(node),
    String(node)
  );
  r.check(
    "a tool that is not installed is null, not a guess",
    whichSync("runpanel-definitely-not-a-real-binary", process.env.PATH || "") === null
  );
  r.check("an empty search path finds nothing", whichSync("node", "") === null);

  return r.result();
}
