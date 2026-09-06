// Shared SQLite connection tuning.
//
// The page cache and the memory map are what keep an 80k-track library's
// working set (indexes, FTS trigrams, metadata blobs) in memory instead of
// re-reading it from disk on every page. The main connection gets the full
// budget; worker-thread connections (scan, genre refresh) get a smaller cache
// because they run one job at a time and the map is shared by the OS anyway.
//
// Both budgets show up in the process RSS (mapped file pages count even though
// the OS can reclaim them), so the defaults are sized for a small self-hosted
// box: the 64 MB cache holds the indexes of an 80k-track library and the
// 256 MB map covers most of its database file. Raise them on hosts with RAM to
// spare, or lower them, with AURRAL_SQLITE_CACHE_MB and AURRAL_SQLITE_MMAP_MB
// (whole megabytes; 0 disables the memory map).
const DEFAULT_CACHE_MB = 64;
const DEFAULT_MMAP_MB = 256;
// Worker connections get a quarter of the main budget (16 MB by default).
const WORKER_CACHE_DIVISOR = 4;
const MIN_WORKER_CACHE_MB = 16;
const MAX_MB = 16 * 1024;

const megabytes = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, MAX_MB);
};

export function resolveSqliteTuning({ worker = false, env = process.env } = {}) {
  const cacheMb = megabytes(env.AURRAL_SQLITE_CACHE_MB, DEFAULT_CACHE_MB);
  const mmapMb = megabytes(env.AURRAL_SQLITE_MMAP_MB, DEFAULT_MMAP_MB);
  return {
    cacheMb: worker ? Math.max(MIN_WORKER_CACHE_MB, Math.floor(cacheMb / WORKER_CACHE_DIVISOR)) : cacheMb,
    mmapMb,
  };
}

// better-sqlite3 is synchronous, so a lock wait on the main connection sleeps
// the whole event loop: every request, the websocket, the static files. The
// main thread therefore waits only briefly (worker transactions are short and
// yield between batches, see yieldWriteLock in libraryMediaStore) and fails
// with SQLITE_BUSY instead of freezing the app. Worker threads have nothing
// else to do, so they wait long enough to ride out anything the main thread
// writes.
const MAIN_BUSY_TIMEOUT_MS = 500;
const WORKER_BUSY_TIMEOUT_MS = 30000;

export function applySqliteTuning(db, options = {}) {
  const tuning = resolveSqliteTuning(options);
  db.pragma(`busy_timeout = ${options.worker ? WORKER_BUSY_TIMEOUT_MS : MAIN_BUSY_TIMEOUT_MS}`);
  // PRAGMA optimize runs ANALYZE on tables whose statistics went stale; the
  // limit bounds each ANALYZE to a sample so a post-scan optimize on a large
  // library holds the write lock for milliseconds, not seconds.
  db.pragma("analysis_limit = 400");
  // Negative cache_size is a budget in KiB rather than a page count.
  db.pragma(`cache_size = -${tuning.cacheMb * 1024}`);
  db.pragma(`mmap_size = ${tuning.mmapMb * 1024 * 1024}`);
  // Sort and GROUP BY scratch b-trees stay in memory instead of temp files.
  db.pragma("temp_store = MEMORY");
  return tuning;
}
