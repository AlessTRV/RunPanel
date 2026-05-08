import path from "path";
import fs from "fs";

// Lazy-resolved data directory. Using a getter prevents Turbopack from evaluating
// the path at build time — it would otherwise create a DirAssetReference for data/,
// walk the directory tree, and crash on venv symlinks pointing outside the project.
let _dataDir: string | undefined;
function dataDir(): string {
  if (!_dataDir) {
    _dataDir = process.env.RUNPANEL_DATA_DIR || `${process.cwd()}/data`;
  }
  return _dataDir;
}

export const config = {
  get dataDir() { return dataDir(); },
  get dbPath() { return path.join(dataDir(), "runpanel.db"); },
  get reposDir() { return path.join(dataDir(), "repos"); },
  get buildsDir() { return path.join(dataDir(), "builds"); },
  get uploadsDir() { return path.join(dataDir(), "uploads"); },
  get logsDir() { return path.join(dataDir(), "logs"); },
  get servicesDir() { return path.join(dataDir(), "services"); },
  get secretFile() { return path.join(dataDir(), ".secret"); },
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
