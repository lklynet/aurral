import path from "path";
import { initializeLibrarySearchIndex } from "./library-search-index.js";
import { initializeLibraryGenreIndex } from "./library-genre-index.js";
import { openAurralDatabase, StartupRefusal } from "./databaseStartup.js";
import { syncDownloadFolderPath } from "../services/downloadFolderConfig.js";
import { ensureDataDir } from "./data-dir.js";

const DATA_DIR = ensureDataDir();

const DB_PATH = process.env.AURRAL_DB_PATH
  ? path.resolve(process.env.AURRAL_DB_PATH)
  : path.join(DATA_DIR, "aurral.db");

let db;
try {
  db = openAurralDatabase({
    dbPath: DB_PATH,
    dataDir: DATA_DIR,
    log: (message) => console.log(`[Database] ${message}`),
  });
} catch (error) {
  if (!(error instanceof StartupRefusal)) throw error;
  console.error(`[Aurral] ${error.message}`);
  process.exit(1);
}

db.exec(`
  DELETE FROM settings WHERE key LIKE 'activeDownloadAttempt:%'
    AND NOT EXISTS (
      SELECT 1 FROM download_jobs
      WHERE id = substr(settings.key, length('activeDownloadAttempt:') + 1) AND status != 'done'
    );
`);
initializeLibraryGenreIndex(db);
initializeLibrarySearchIndex(db);

export const dbHelpers = {
  parseJSON: (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  stringifyJSON: (obj) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

const existingDownloadFolder = db
  .prepare("SELECT value FROM settings WHERE key = ?")
  .get("downloadFolderPath");
syncDownloadFolderPath(existingDownloadFolder?.value || null);

export { db };
