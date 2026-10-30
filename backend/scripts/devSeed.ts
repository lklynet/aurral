import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAurralDataDir, resolveAurralDbPath } from "../config/data-dir.ts";
import { extractZipEntry, readZipEntries } from "../services/zip.ts";

const ARTWORK_ENTRY = /^custom-artwork\/(\w[\w.-]*)$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const backupArg = process.argv[2];
if (!backupArg) fail("Usage: pnpm run dev:seed <backup.zip>");
const backup = path.resolve(backupArg);
const dataDir = resolveAurralDataDir();
const dbPath = resolveAurralDbPath();
if (existsSync(dbPath))
  fail(`${dbPath} already exists. Move ${dataDir} aside to seed this worktree.`);

const entries = await readZipEntries(backup);
const database = entries.find((entry) => entry.name === "aurral.db");
if (!database) fail("This file is not an Aurral backup.");

const artworkDir = path.join(dataDir, "custom-artwork");
await fs.mkdir(artworkDir, { recursive: true });

try {
  await extractZipEntry(backup, database, dbPath);
  for (const entry of entries) {
    const name = ARTWORK_ENTRY.exec(entry.name)?.[1];
    if (name) await extractZipEntry(backup, entry, path.join(artworkDir, name));
  }
  const { seedDatabase, SEED_LOGIN } = await import("../services/devSeed.ts");
  const { downloadFolder } = seedDatabase();
  const { db } = await import("../config/db-sqlite.ts");
  db.close();
  console.log(`Seeded ${dataDir} from ${backup}.`);
  console.log(`Sign in as ${SEED_LOGIN.username} / ${SEED_LOGIN.password}.`);
  console.log(
    "Integrations, sessions, share links and queued work are cleared. Flows, missing-track search and automatic upgrades are off.",
  );
  if (downloadFolder) {
    console.log(
      `The Library reads and writes ${downloadFolder}. Mount a copy or overlay there, never the real folder.`,
    );
  }
} catch (error) {
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) => fs.rm(`${dbPath}${suffix}`, { force: true })),
  );
  throw error;
}
