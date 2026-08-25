import path from "path";
import fs from "fs";
import crypto from "crypto";
import { getEnv } from "./env";

const env = () => getEnv();

export const config = {
  get dataDir() {
    return env().dataDir;
  },
  get dbFile() {
    const db = env().db;
    return db.driver === "sqlite" ? db.file : null;
  },
  get reposDir() {
    return path.join(env().dataDir, "repos");
  },
  get buildsDir() {
    return path.join(env().dataDir, "builds");
  },
  get uploadsDir() {
    return path.join(env().dataDir, "uploads");
  },
  get logsDir() {
    return path.join(env().dataDir, "logs");
  },
  get servicesDir() {
    return path.join(env().dataDir, "services");
  },
  get tmpDir() {
    return path.join(env().dataDir, "tmp");
  },
  get backupsDir() {
    return path.join(env().dataDir, "backups");
  },
  /**
   * Finished archives, filed by year and month. Two years of nightlies in one
   * flat directory is a directory nobody can read, and age-based retention
   * would have to stat every entry to find the old ones.
   */
  get backupArchivesDir() {
    return path.join(config.backupsDir, "archives");
  },
  /**
   * Where a run assembles its dumps. Deliberately under the data dir and not in
   * the OS temp dir: publishing an archive is then a rename on the same
   * filesystem, which is atomic, instead of a copy that can be interrupted.
   */
  get backupStagingDir() {
    return path.join(config.backupsDir, "staging");
  },
  get backupUploadsDir() {
    return path.join(config.backupsDir, "uploads");
  },
  /**
   * Where the updater parks a copy of the store before it resets the tree.
   *
   * A directory of its own rather than a loose file under `dataDir`, so the one
   * chmod below covers every dump it will ever write.
   */
  get panelUpdateDir() {
    return path.join(env().dataDir, "panel-update");
  },
  get secretFile() {
    return path.join(env().dataDir, ".secret");
  },
};

export function ensureDataDirs() {
  const dirs = [
    config.dataDir,
    config.reposDir,
    config.buildsDir,
    config.uploadsDir,
    config.logsDir,
    config.servicesDir,
    config.tmpDir,
    config.backupsDir,
    config.backupArchivesDir,
    config.backupStagingDir,
    config.backupUploadsDir,
    config.panelUpdateDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Both hold a whole copy of the panel's store — encrypted env vars, registry
  // logins, session hashes — and on a shared host the default 0755 would let
  // any local user read last night's backup, or the copy the updater took
  // twenty minutes ago.
  for (const dir of [config.backupsDir, config.panelUpdateDir]) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* Windows and some network filesystems have no mode bits to set. */
    }
  }
}

let _secret: string | null = null;

/**
 * The AES key used to encrypt stored env vars and service credentials.
 *
 * Precedence: `RUNPANEL_SECRET` from the environment, else a 32-byte key
 * persisted at `<dataDir>/.secret` (0600) and generated on first run.
 */
export function getSecret(): string {
  if (_secret) return _secret;

  const fromEnv = env().secret;
  if (fromEnv) {
    _secret = fromEnv;
    return _secret;
  }

  ensureDataDirs();

  if (fs.existsSync(config.secretFile)) {
    _secret = fs.readFileSync(config.secretFile, "utf-8").trim();
    return _secret;
  }

  _secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(config.secretFile, _secret, { mode: 0o600 });
  return _secret;
}
