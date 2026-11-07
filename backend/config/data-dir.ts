import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");
const CANONICAL_CONTAINER_DATA_DIR = "/config";
const LEGACY_CONTAINER_DATA_DIR = "/app/backend/data";

function isDirectory(dir: string) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasDatabaseFile(dir: string) {
  try {
    return fs.existsSync(path.join(dir, "aurral.db"));
  } catch {
    return false;
  }
}

export function resolveAurralDataDir() {
  if (process.env.AURRAL_DATA_DIR) {
    return path.resolve(process.env.AURRAL_DATA_DIR);
  }

  if (isDirectory(CANONICAL_CONTAINER_DATA_DIR)) {
    return CANONICAL_CONTAINER_DATA_DIR;
  }

  return DEFAULT_DATA_DIR;
}

export const databaseOnlyInLegacyDataDir = ({
  canonical = CANONICAL_CONTAINER_DATA_DIR,
  legacy = LEGACY_CONTAINER_DATA_DIR,
} = {}) =>
  !process.env.AURRAL_DATA_DIR &&
  !process.env.AURRAL_DB_PATH &&
  !hasDatabaseFile(canonical) &&
  hasDatabaseFile(legacy);

export function resolveAurralDbPath() {
  return process.env.AURRAL_DB_PATH
    ? path.resolve(process.env.AURRAL_DB_PATH)
    : path.join(resolveAurralDataDir(), "aurral.db");
}

export function ensureDataDir(dir = resolveAurralDataDir()) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
