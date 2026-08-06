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
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
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
