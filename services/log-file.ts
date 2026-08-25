import fs from "fs";
import path from "path";

/**
 * One buffered append-only log file, addressed by an id.
 *
 * This started as the deploy-only `BuildLogFile` and moved here when backups
 * and restores needed the same three properties: a chatty producer must not
 * cost one syscall per line, the file must be tailable while it is being
 * written, and an id that came from the outside must never become a path.
 *
 * The id check is the important one. It runs *before* anything is joined, so a
 * caller cannot reach `../../.secret` — `path.join` would happily normalise it
 * away and hand back a path that looks fine.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isLogId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function logPathFor(dir: string, id: string): string {
  if (!isLogId(id)) throw new Error(`Invalid log id: ${id}`);
  return path.join(dir, `${id}.log`);
}

export class AppendLogFile {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  readonly file: string;
  private readonly flushMs: number;

  // Declared and assigned rather than written as constructor parameter
  // properties: Node's strip-only TypeScript loader rejects those, and the unit
  // suites import modules like this one directly rather than through a bundler.
  constructor(file: string, flushMs = 200) {
    this.file = file;
    this.flushMs = flushMs;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(line: string): void {
    this.pending.push(line);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;

    const chunk = `${this.pending.join("\n")}\n`;
    this.pending = [];
    try {
      // 0600, and only on creation, so the hot path pays nothing: these files
      // carry build output, remote URLs and the names of environment
      // variables, and an update log carries whatever git said when a fetch
      // failed. None of that is for every local user on a shared host.
      fs.appendFileSync(this.file, chunk, { mode: 0o600 });
    } catch (err) {
      console.error(`[log-file] Failed to write ${path.basename(this.file)}:`, err);
    }
  }
}

/** Read a log. `tailLines` returns only the end of it. */
export function readLogFile(file: string, tailLines?: number): string {
  if (!fs.existsSync(file)) return "";

  try {
    const content = fs.readFileSync(file, "utf8");
    if (!tailLines) return content;

    const lines = content.split("\n");
    return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
  } catch {
    return "";
  }
}

export function removeLogFile(file: string): void {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    /* a log that cannot be removed is not worth failing a sweep over */
  }
}

/** Drop every `<id>.log` in `dir` whose id is not in `keepIds`. */
export function pruneLogDir(dir: string, keepIds: Set<string>): number {
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".log")) continue;
    if (keepIds.has(entry.slice(0, -4))) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
      removed++;
    } catch {
      /* keep going — one stuck file should not stop the sweep */
    }
  }
  return removed;
}
