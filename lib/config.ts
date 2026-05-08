import path from "path";
import fs from "fs";

const DATA_DIR = process.env.RUNPANEL_DATA_DIR || `${process.cwd()}/data`;

export const config = {
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, "runpanel.db"),
  reposDir: path.join(DATA_DIR, "repos"),
  buildsDir: path.join(DATA_DIR, "builds"),
  uploadsDir: path.join(DATA_DIR, "uploads"),
  logsDir: path.join(DATA_DIR, "logs"),
  servicesDir: path.join(DATA_DIR, "services"),
  secretFile: path.join(DATA_DIR, ".secret"),
};

export function ensureDataDirs() {
  const dirs = [
    config.dataDir,
    config.reposDir,
    config.buildsDir,
    config.uploadsDir,
    config.logsDir,
    config.servicesDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let _secret: string | null = null;

export function getSecret(): string {
  if (_secret) return _secret;

  if (process.env.RUNPANEL_SECRET) {
    _secret = process.env.RUNPANEL_SECRET;
    return _secret;
  }

  ensureDataDirs();

  if (fs.existsSync(config.secretFile)) {
    _secret = fs.readFileSync(config.secretFile, "utf-8").trim();
    return _secret;
  }

  const crypto = require("crypto") as typeof import("crypto");
  _secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(config.secretFile, _secret, { mode: 0o600 });
  return _secret;
}
