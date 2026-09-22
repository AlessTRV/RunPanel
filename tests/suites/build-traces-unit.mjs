import { createReporter } from "../harness.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The build must not trace the data directory.
 *
 * Next's webpack build runs @vercel/nft over every server route, and nft
 * evaluates path expressions it can resolve statically — `process.cwd()`
 * included. `lib/env.ts` built the default data directory as
 * `path.join(process.cwd(), "data")`, which nft resolved to a directory and
 * emitted whole, into all seventy routes that import it: every project's
 * checkout, every build output, every log and backup the panel had ever
 * written. On a server hosting seven projects that walk took the build past a
 * 4 GB heap and the self-update failed with "JavaScript heap out of memory".
 *
 * `outputFileTracingExcludes` is not a fix: Next applies it after nft has
 * already walked everything (the webpack plugin passes nft no ignores).
 *
 * Reads the last `next build` output rather than running one — the runner
 * already expects a fresh build for every suite that starts a server — and
 * says so when there is nothing to read.
 */
export const meta = { name: "build-traces-unit", needsDocker: false, drivers: [], standalone: true };

function* nftFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* nftFiles(full);
    else if (entry.endsWith(".nft.json")) yield full;
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("build-traces-unit");
  const server = join(repoRoot, process.env.RUNPANEL_DIST_DIR || ".next", "server");

  if (!existsSync(server)) {
    r.note("no build output to inspect — run `npm run build` first");
    r.check("a build exists to inspect", false, server);
    return r.result();
  }

  const dataDir = resolve(repoRoot, "data") + sep;
  const offenders = new Map();
  let traces = 0;

  for (const file of nftFiles(server)) {
    traces++;
    const { files = [] } = JSON.parse(readFileSync(file, "utf8"));
    const base = join(file, "..");
    const hits = files.filter((entry) => resolve(base, entry).startsWith(dataDir));
    if (hits.length > 0) offenders.set(relative(server, file), hits);
  }

  r.check("the build produced route traces to inspect", traces > 0, String(traces));
  const sample = [...offenders.entries()][0];
  r.check(
    "no route traces anything inside the data directory",
    offenders.size === 0,
    sample ? `${offenders.size} route(s), e.g. ${sample[0]}: ${sample[1].slice(0, 3).join(", ")}` : ""
  );

  return r.result();
}
