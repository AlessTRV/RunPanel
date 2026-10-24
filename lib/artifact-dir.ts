import path from "path";

/**
 * Where a deployment's checkout lives now, if the data directory has moved.
 *
 * `deployments.artifact_dir` is stored absolute, and every restart starts the
 * app there. Moving the panel's data (`RUNPANEL_DATA_DIR`) left every project
 * not deployed since pointing at the old tree: PM2 failed to spawn in a cwd
 * that no longer existed, never got a pid, and still reported "online" — no
 * log line, no restart, nothing on the page but a green dot.
 *
 * The checkout is always `<reposDir>/<slug>`, or a folder inside it for a
 * static build, so the part after `repos/<slug>` carries over to wherever
 * `reposDir` is today. Returns null when the stored path is not shaped like
 * that, or already points there.
 */
export function relocatedArtifactDir(stored: string, slug: string, reposDir: string): string | null {
  const parts = stored.split(/[\\/]+/);
  let at = -1;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === "repos" && parts[i + 1] === slug) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;

  const relocated = path.join(reposDir, slug, ...parts.slice(at + 2));
  return path.normalize(relocated) === path.normalize(stored) ? null : relocated;
}

/**
 * The start command with the old directory swapped for the new one. Only the
 * static builder embeds it (`npx serve -s <dir>`); every other command passes
 * through untouched.
 */
export function relocatedStartCmd(startCmd: string, from: string, to: string): string {
  return startCmd.split(from).join(to);
}
