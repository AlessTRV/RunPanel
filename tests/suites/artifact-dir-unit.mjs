import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Following a checkout after the data directory moved.
 *
 * A restart starts the app in the directory its last deploy recorded. When
 * `RUNPANEL_DATA_DIR` changed, that path pointed at a tree that was gone, and
 * PM2 showed the app online with no pid and nothing in its log.
 *
 * Standalone: pure path arithmetic, no filesystem.
 */
export const meta = { name: "artifact-dir-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("artifact-dir-unit");
  const { relocatedArtifactDir, relocatedStartCmd } = await import(
    pathToFileURL(join(repoRoot, "lib", "artifact-dir.ts")).href
  );

  const newRepos = join("/root", "runpanel-data", "repos");

  {
    const got = relocatedArtifactDir("/root/websites/RunPanel/data/repos/rsi-manager", "rsi-manager", newRepos);
    r.check("checkout follows the moved repos dir", got === join(newRepos, "rsi-manager"), String(got));
  }

  {
    // The static builder serves a folder inside the checkout.
    const got = relocatedArtifactDir("/old/data/repos/site/dist", "site", newRepos);
    r.check("a folder inside the checkout keeps its tail", got === join(newRepos, "site", "dist"), String(got));
  }

  {
    // A repository that itself has a `repos/<slug>` folder: the outermost one
    // past the data dir is not the one to match, the last is.
    const got = relocatedArtifactDir("/old/data/repos/app/repos/app", "app", newRepos);
    r.check("the last repos/<slug> pair wins", got === join(newRepos, "app"), String(got));
  }

  {
    const got = relocatedArtifactDir(join(newRepos, "bitmade"), "bitmade", newRepos);
    r.check("a path already in place is not relocated", got === null, String(got));
  }

  {
    const got = relocatedArtifactDir("/srv/elsewhere/bitmade", "bitmade", newRepos);
    r.check("a path not under repos/<slug> is left alone", got === null, String(got));
  }

  {
    const got = relocatedArtifactDir("/old/data/repos/other", "bitmade", newRepos);
    r.check("another project's checkout does not match", got === null, String(got));
  }

  {
    const got = relocatedStartCmd("npx serve -s /old/repos/site/dist", "/old/repos/site/dist", "/new/repos/site/dist");
    r.check("the static start command follows", got === "npx serve -s /new/repos/site/dist", got);
    const plain = relocatedStartCmd("venv/bin/python main.py", "/old/repos/x", "/new/repos/x");
    r.check("any other command is untouched", plain === "venv/bin/python main.py", plain);
  }

  return r.result();
}
