import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");
const CONTAINER_DATA_DIR = "/config";

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveAurralDataDir() {
  if (process.env.AURRAL_DATA_DIR) {
    return path.resolve(process.env.AURRAL_DATA_DIR);
  }
  return isDirectory(CONTAINER_DATA_DIR) ? CONTAINER_DATA_DIR : DEFAULT_DATA_DIR;
}

export function ensureDataDir(dir = resolveAurralDataDir()) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
