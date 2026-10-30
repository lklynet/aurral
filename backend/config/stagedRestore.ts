import fs from "node:fs";
import path from "node:path";
import { asAppError } from "../../lib/errors.ts";

export const STAGED_RESTORE_DIR = "restore";

function move(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (asAppError(error)?.code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function applyStagedRestore(dataDir: string, dbPath: string) {
  const staged = path.join(dataDir, STAGED_RESTORE_DIR);
  const stagedDb = path.join(staged, "aurral.db");
  if (!fs.existsSync(stagedDb)) {
    fs.rmSync(staged, { recursive: true, force: true });
    return null;
  }
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const previous = path.join(dataDir, `before-restore-${stamp}`);
  const replace = (current: string, next?: string) => {
    if (fs.existsSync(current)) {
      fs.mkdirSync(previous, { recursive: true });
      move(current, path.join(previous, path.basename(current)));
    }
    if (next) move(next, current);
  };
  const stagedArtwork = path.join(staged, "custom-artwork");
  if (fs.existsSync(stagedArtwork)) replace(path.join(dataDir, "custom-artwork"), stagedArtwork);
  fs.rmSync(path.join(dataDir, "library-artwork"), { recursive: true, force: true });
  replace(dbPath);
  replace(`${dbPath}-wal`);
  replace(`${dbPath}-shm`);
  move(stagedDb, dbPath);
  fs.rmSync(staged, { recursive: true, force: true });
  return previous;
}
