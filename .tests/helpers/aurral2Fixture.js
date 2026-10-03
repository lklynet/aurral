import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "aurral-2");

export function loadAurral2Fixture(name) {
  const root = mkdtempSync(path.join(tmpdir(), `aurral-2-${name}-`));
  const dataDir = path.join(root, "config");
  const downloadRoot = path.join(root, "downloads");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(downloadRoot, { recursive: true });
  const files = JSON.parse(readFileSync(path.join(fixtureDir, `${name}.files.json`), "utf8"));
  for (const relative of files) {
    const filePath = path.join(root, relative);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `fixture:${relative}`);
  }
  const dbPath = path.join(dataDir, "aurral.db");
  const db = new Database(dbPath);
  db.exec(readFileSync(path.join(fixtureDir, `${name}.sql`), "utf8").replaceAll("__ROOT__", root));
  db.close();
  return { root, dataDir, dbPath, downloadRoot };
}
