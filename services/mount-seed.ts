import path from "path";
import { config } from "@/lib/config";
import { docker, dockerFromFile, dockerToFile, dockerTry } from "./docker/cli";

/**
 * Filling a host directory with what a container has, before binding over it.
 *
 * A bind mount **substitutes**: Docker copies nothing into it, and whatever was
 * at that path inside the container is covered rather than carried out. So the
 * first time a bind is switched on, an empty host directory shows the container
 * an empty directory — and the whole point of the feature is that it does not.
 *
 * Everything here goes through the daemon, never through `fs`. The panel may
 * itself be a container, and even when it is not, `fs` answers for the panel's
 * mount namespace while `docker run -v` resolves against the daemon's — and only
 * one of those is where the container will look.
 *
 * It knows nothing about services or projects: it is handed an image, a couple
 * of paths and somewhere to report, and it moves bytes.
 */

const PROGRESS_INTERVAL_MS = 3_000;

export interface SeedReporter {
  emit: (line: string) => void;
  progress?: (copiedKb: number, totalKb: number | null) => void;
}

/** `docker run --rm` with a shell, one fixed command, and no interpolation. */
async function probe(image: string, mounts: string[], script: string): Promise<string | null> {
  const result = await dockerTry(
    ["run", "--rm", "--entrypoint", "sh", ...mounts, image, "-c", script],
    { timeout: 120_000 }
  );
  return result ? result.stdout.trim() : null;
}

/**
 * What is already at the destination.
 *
 * `-v` creates the directory when it is missing, so this doubles as "does it
 * exist". `lost+found` does not count: a freshly formatted ext4 mount point has
 * one and would otherwise be permanently refused.
 */
export async function destinationEntries(image: string, destination: string): Promise<string[]> {
  const out = await probe(image, ["-v", `${destination}:/dst`], "ls -A /dst 2>/dev/null | head -n 20");
  if (out === null) throw new Error(`Non riesco a leggere ${destination}`);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "lost+found");
}

/** Size in KiB. `du -sk` rather than `du -sb`, which is GNU-only. */
export async function sizeKb(image: string, mount: string): Promise<number | null> {
  const out = await probe(image, ["-v", `${mount}:/from:ro`], "du -sk /from | cut -f1");
  const value = Number.parseInt((out ?? "").split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

/** Free KiB at the destination, from `df -Pk`. */
export async function freeKb(image: string, destination: string): Promise<number | null> {
  const out = await probe(image, ["-v", `${destination}:/dst`], "df -Pk /dst | tail -n1");
  const value = Number.parseInt((out ?? "").split(/\s+/)[3] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Copy one mounted location into another, in a container that has both.
 *
 * `/from/.` and not `/from/*`: the glob misses dotfiles. `-a` is what preserves
 * ownership and mode, and that is not cosmetic — Postgres refuses to start
 * unless its data directory belongs to its own uid and is 0700, so a copy that
 * lost them produces a service that comes up, fails, and rolls back for a reason
 * nobody would guess from the message.
 *
 * Progress is polled rather than printed: `cp -av` over a data directory is tens
 * of thousands of lines through an SSE stream, where a size every three seconds
 * says the same thing once.
 */
export async function copyBetweenMounts(opts: {
  container: string;
  image: string;
  from: string;
  to: string;
  report: SeedReporter;
}): Promise<void> {
  const { container, image, from, to, report } = opts;
  const totalKb = await sizeKb(image, from);
  report.emit(totalKb ? `Da copiare: ${Math.round(totalKb / 1024)} MB` : "Copia in corso…");

  await dockerTry(["rm", "-f", container], { timeout: 30_000 });
  await docker(
    [
      "run", "-d", "--name", container, "--entrypoint", "sh",
      "-v", `${from}:/from:ro`,
      "-v", `${to}:/to`,
      image,
      "-c", "set -e; cp -a /from/. /to/; sync",
    ],
    { timeout: 60_000 }
  );

  const progress = setInterval(() => {
    void (async () => {
      const result = await dockerTry(["exec", container, "du", "-sk", "/to"], { timeout: 20_000 });
      const copiedKb = Number.parseInt((result?.stdout ?? "").split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(copiedKb)) return;
      report.progress?.(copiedKb, totalKb);
      report.emit(
        totalKb
          ? `  ${Math.round(copiedKb / 1024)} MB di ${Math.round(totalKb / 1024)} MB`
          : `  ${Math.round(copiedKb / 1024)} MB`
      );
    })();
  }, PROGRESS_INTERVAL_MS);
  progress.unref?.();

  try {
    const waited = await docker(["wait", container], { timeout: 24 * 60 * 60_000 });
    const code = Number.parseInt(waited.stdout.trim(), 10);
    if (code !== 0) {
      const logs = await dockerTry(["logs", "--tail", "20", container], { timeout: 20_000 });
      throw new Error(`La copia è fallita (codice ${code}): ${logs?.stderr || logs?.stdout || ""}`.trim());
    }
  } finally {
    clearInterval(progress);
    await dockerTry(["rm", "-f", container], { timeout: 30_000 });
  }

  report.emit("Copia completata.");
}

/**
 * Copy a path that lives in a container's own filesystem, not in a mount.
 *
 * A folder like `/etc/postgresql` is part of the image: there is no volume to
 * mount read-only and copy from. `docker cp` reads it through the daemon — the
 * only party that can see it — as a tar, and a second throwaway container
 * unpacks that tar into the host directory. It goes through a file in the
 * panel's own tmp rather than a pipe because the two halves are separate
 * processes and the existing helpers stream to and from files.
 */
export async function copyOutOfContainer(opts: {
  sourceContainer: string;
  image: string;
  target: string;
  to: string;
  report: SeedReporter;
}): Promise<void> {
  const { sourceContainer, image, target, to, report } = opts;
  const archive = path.join(config.tmpDir, `mountseed-${Date.now()}-${process.pid}.tar`);
  report.emit(`Copio ${target} dal container…`);

  try {
    await dockerToFile(["cp", `${sourceContainer}:${target}/.`, "-"], archive);
    await dockerFromFile(
      [
        "run", "--rm", "-i", "--entrypoint", "sh",
        "-v", `${to}:/to`,
        image,
        "-c", "tar -C /to -xf -",
      ],
      archive,
      { decompress: false, onStderr: (line) => report.emit(`  ${line}`) }
    );
    report.emit("Copia completata.");
  } finally {
    const { rmSync } = await import("fs");
    try {
      rmSync(archive, { force: true });
    } catch {
      /* a leftover tar in tmp is swept by the housekeeping timer */
    }
  }
}
