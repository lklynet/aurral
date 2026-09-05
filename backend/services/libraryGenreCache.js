import { Worker } from "node:worker_threads";
import { db, DB_PATH } from "../config/db-sqlite.js";
import {
  GENRE_LIST_SETTING_PREFIX,
  GENRE_STATS_SETTING_PREFIX,
  computeLibraryGenreList,
  computeLibraryGenreStats,
  genreCacheKey,
  rebuildStoredLibraryGenreStats,
  writeLibraryGenreSnapshot,
} from "../config/library-search-index.js";

// Genre stats and the Subsonic genre list are served from a persisted snapshot
// (settings rows) mirrored in memory. Library mutations never drop the snapshot;
// they mark it stale and a debounced worker thread recomputes it off the main
// thread. Readers see the previous snapshot until the refresh lands.

const REFRESH_DEBOUNCE_MS = 15_000;
const WORKER_URL = new URL("./libraryGenreRefreshWorker.js", import.meta.url);

const statsCache = new Map();
const listCache = new Map();
let refreshTimer = null;
let activeRefresh = null;
let refreshRequested = false;

const parseArray = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readStored = (key) =>
  parseArray(db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value);

function readCached(cache, prefix, sourceFilter, availableOnly, compute) {
  const cacheKey = genreCacheKey(sourceFilter, availableOnly);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const stored = readStored(`${prefix}${cacheKey}`);
  if (stored) {
    cache.set(cacheKey, stored);
    return stored;
  }
  // No snapshot yet (fresh database or first run after upgrade): compute inline
  // once, and let the background refresh persist it for next time.
  const computed = compute();
  cache.set(cacheKey, computed);
  scheduleLibraryGenreRefresh({ delayMs: 0 });
  return computed;
}

export function getLibraryGenreStats({ sourceFilter = null, availableOnly = false } = {}) {
  return readCached(statsCache, GENRE_STATS_SETTING_PREFIX, sourceFilter, availableOnly, () =>
    computeLibraryGenreStats(db, { sourceFilter, availableOnly }));
}

export function getLibraryGenreList({ sourceFilter = null, availableOnly = false } = {}) {
  return readCached(listCache, GENRE_LIST_SETTING_PREFIX, sourceFilter, availableOnly, () =>
    computeLibraryGenreList(db, { sourceFilter, availableOnly }));
}

// Drop the in-memory mirror so the next read reloads the persisted snapshot.
export function clearLibraryGenreMemoryCache() {
  statsCache.clear();
  listCache.clear();
}

// Synchronous full recompute on the calling thread. Used by tests and by the
// search-index migration; scans use the background refresh instead.
export function rebuildLibraryGenreSnapshot() {
  rebuildStoredLibraryGenreStats(db);
  clearLibraryGenreMemoryCache();
}

const applySnapshot = (entries) => {
  writeLibraryGenreSnapshot(db, entries);
  clearLibraryGenreMemoryCache();
};

function computeSnapshotInWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { dbPath: DB_PATH } });
    let settled = false;
    const finish = (handler) => (value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    worker.once("message", finish((message) => resolve(message?.entries || [])));
    worker.once("error", finish(reject));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`genre refresh worker exited with code ${code}`)))();
    });
  });
}

export function runLibraryGenreRefresh() {
  if (activeRefresh) {
    refreshRequested = true;
    return activeRefresh;
  }
  activeRefresh = (async () => {
    try {
      do {
        refreshRequested = false;
        applySnapshot(await computeSnapshotInWorker());
      } while (refreshRequested);
    } catch (error) {
      console.error("[libraryGenreCache] genre refresh failed:", error);
    } finally {
      activeRefresh = null;
    }
  })();
  return activeRefresh;
}

// Debounced: back-to-back scans and mutation bursts collapse into one refresh
// after the library goes quiet. No-op under tests, which call
// rebuildLibraryGenreSnapshot() or runLibraryGenreRefresh() explicitly.
export function scheduleLibraryGenreRefresh({ delayMs = REFRESH_DEBOUNCE_MS } = {}) {
  if (process.env.NODE_ENV === "test") return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    runLibraryGenreRefresh();
  }, delayMs);
  refreshTimer.unref?.();
}

export function isLibraryGenreRefreshActive() {
  return Boolean(activeRefresh || refreshTimer);
}
