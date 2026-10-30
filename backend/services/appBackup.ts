import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { db } from "../config/db-sqlite.ts";
import { STAGED_RESTORE_DIR } from "../config/stagedRestore.ts";
import { asAppError } from "../../lib/errors.ts";
import { extractZipEntry, planZip, readZipEntries, ZipFormatError } from "./zip.ts";

export class BackupError extends Error {}

const DATA_DIR = resolveAurralDataDir();
const SNAPSHOT_PATH = path.join(DATA_DIR, ".backup-snapshot.db");
const ARTWORK_DIR = path.join(DATA_DIR, "custom-artwork");
const RESTORE_DIR = path.join(DATA_DIR, STAGED_RESTORE_DIR);
const ARTWORK_ENTRY = /^custom-artwork\/(\w[\w.-]*)$/;
const NOT_A_BACKUP = "This file is not an Aurral backup.";

let busy = false;

function claim() {
  if (busy) throw new BackupError("Another backup or restore is already running.");
  busy = true;
}

export async function createBackup() {
  claim();
  const release = async () => {
    await fs.rm(SNAPSHOT_PATH, { force: true });
    busy = false;
  };
  try {
    await fs.rm(SNAPSHOT_PATH, { force: true });
    await db.backup(SNAPSHOT_PATH);
    const snapshot = new Database(SNAPSHOT_PATH);
    try {
      snapshot.pragma("journal_mode = DELETE");
      snapshot.pragma("secure_delete = ON");
      snapshot.exec("DELETE FROM sessions");
    } finally {
      snapshot.close();
    }
    const artwork = await fs.readdir(ARTWORK_DIR, { withFileTypes: true }).catch((error) => {
      if (asAppError(error)?.code === "ENOENT") return [];
      throw error;
    });
    const plan = await planZip([
      { name: "aurral.db", path: SNAPSHOT_PATH },
      ...artwork
        .filter((entry) => entry.isFile() && ARTWORK_ENTRY.test(`custom-artwork/${entry.name}`))
        .map((entry) => ({
          name: `custom-artwork/${entry.name}`,
          path: path.join(ARTWORK_DIR, entry.name),
        })),
    ]);
    return { plan, release };
  } catch (error) {
    await release();
    throw error;
  }
}

function checkDatabase(file: string) {
  let staged: Database.Database | undefined;
  try {
    staged = new Database(file, { fileMustExist: true });
    const schemaVersion = staged
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'schemaVersion'")
      .get();
    if (!schemaVersion) throw new BackupError(NOT_A_BACKUP);
    if (staged.pragma("quick_check", { simple: true }) !== "ok")
      throw new BackupError("The database in this backup is damaged.");
  } catch (error) {
    if (error instanceof Database.SqliteError) throw new BackupError(NOT_A_BACKUP);
    throw error;
  } finally {
    staged?.close();
  }
}

export async function stageRestore(body: ReadableStream<Uint8Array>) {
  claim();
  const upload = path.join(RESTORE_DIR, "upload.zip");
  const partial = path.join(RESTORE_DIR, "aurral.db.partial");
  try {
    await fs.rm(RESTORE_DIR, { recursive: true, force: true });
    await fs.mkdir(path.join(RESTORE_DIR, "custom-artwork"), { recursive: true });
    await pipeline(body, createWriteStream(upload));
    const entries = await readZipEntries(upload);
    const database = entries.find((entry) => entry.name === "aurral.db");
    if (!database) throw new BackupError(NOT_A_BACKUP);
    await extractZipEntry(upload, database, partial);
    checkDatabase(partial);
    for (const entry of entries) {
      const name = ARTWORK_ENTRY.exec(entry.name)?.[1];
      if (name)
        await extractZipEntry(upload, entry, path.join(RESTORE_DIR, "custom-artwork", name));
    }
    await fs.rm(upload);
    await fs.rename(partial, path.join(RESTORE_DIR, "aurral.db"));
  } catch (error) {
    await fs.rm(RESTORE_DIR, { recursive: true, force: true });
    if (error instanceof ZipFormatError) throw new BackupError(error.message);
    throw error;
  } finally {
    busy = false;
  }
}
