// Shared SQLite connection tuning.
//
// The page cache and the memory map are what keep an 80k-track library's
// working set (indexes, FTS trigrams, metadata blobs) in memory instead of
// re-reading it from disk on every page. The main connection gets the full
// budget; worker-thread connections (scan, genre refresh) get a smaller cache
// because they run one job at a time and the map is shared by the OS anyway.
//
// Override with AURRAL_SQLITE_CACHE_MB and AURRAL_SQLITE_MMAP_MB (whole
// megabytes; 0 disables the memory map).
const DEFAULT_CACHE_MB = 256;
const DEFAULT_MMAP_MB = 1024;
// Worker connections get a quarter of the main budget (64 MB by default).
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

export function applySqliteTuning(db, options = {}) {
  const tuning = resolveSqliteTuning(options);
  db.pragma("busy_timeout = 5000");
  // Negative cache_size is a budget in KiB rather than a page count.
  db.pragma(`cache_size = -${tuning.cacheMb * 1024}`);
  db.pragma(`mmap_size = ${tuning.mmapMb * 1024 * 1024}`);
  // Sort and GROUP BY scratch b-trees stay in memory instead of temp files.
  db.pragma("temp_store = MEMORY");
  return tuning;
}
