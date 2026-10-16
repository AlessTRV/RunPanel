/**
 * Applications in `pm2 jlist` output, counted the way `pm2 save` counts them:
 * modules such as pm2-logrotate are left out of the dump, so they do not count.
 *
 * Output that is not a JSON array (a banner, an error) counts as one process:
 * a probe that cannot read the list should still warn rather than silence the
 * check it feeds.
 */
export function countPm2Processes(stdout: string): number {
  // jlist prints the list on one line, possibly after daemon messages that
  // themselves start with a bracket ("[PM2] Spawning PM2 daemon…").
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trimStart().startsWith("[")) continue;
    let list: unknown;
    try {
      list = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    return list.filter((p) => {
      const env = (p as { pm2_env?: { pmx_module?: unknown } } | null)?.pm2_env;
      return !env?.pmx_module;
    }).length;
  }
  return 1;
}
