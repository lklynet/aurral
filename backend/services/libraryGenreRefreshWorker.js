// Worker-thread entry: recompute the persisted genre snapshot on its own SQLite
// connection so the main thread never blocks on the json_each scans.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { applySqliteTuning } from "../config/sqlite-tuning.js";
import { computeLibraryGenreSnapshot } from "../config/library-search-index.js";

const db = new Database(String(workerData?.dbPath || ""));
try {
  applySqliteTuning(db, { worker: true });
  db.pragma("query_only = 1");
  parentPort.postMessage({ entries: computeLibraryGenreSnapshot(db) });
} finally {
  db.close();
}
