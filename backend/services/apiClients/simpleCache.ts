const SWEEP_INTERVAL_MS = 60_000;

type CacheEntry = { expires: number; staleUntil: number };
type CacheRegistration = {
  cache: WeakRef<Map<unknown, CacheEntry>>;
  now: () => number;
};

const idleCaches = new Set<CacheRegistration>();
let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

function removeExpired(cache: Map<unknown, CacheEntry>, currentTime: number) {
  for (const [key, entry] of cache) {
    if (entry.staleUntil < currentTime) cache.delete(key);
  }
}

function scheduleIdleSweep(registration: CacheRegistration) {
  idleCaches.add(registration);
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    for (const entry of idleCaches) {
      const cache = entry.cache.deref();
      if (cache) removeExpired(cache, entry.now());
      if (!cache?.size) idleCaches.delete(entry);
    }
    if (idleCaches.size === 0) {
      if (idleSweepTimer) clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}

export default function createCache(
  defaultTtlSeconds = 300,
  maxEntries = 1000,
  { now = () => Date.now() } = {},
) {
  const cache = new Map();
  const registration = { cache: new WeakRef(cache), now };
  let nextSweepAt = now() + SWEEP_INTERVAL_MS;

  const sweepExpired = (currentTime: number) => {
    if (currentTime < nextSweepAt) return;
    nextSweepAt = currentTime + SWEEP_INTERVAL_MS;
    removeExpired(cache, currentTime);
  };

  return {
    get(key: unknown) {
      const currentTime = now();
      sweepExpired(currentTime);
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires < currentTime) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    getWithStale(key: unknown) {
      const currentTime = now();
      sweepExpired(currentTime);
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires >= currentTime) {
        return { value: entry.value, stale: false };
      }
      if (entry.staleUntil > currentTime) {
        return { value: entry.value, stale: true };
      }
      cache.delete(key);
      return undefined;
    },
    set(key: unknown, value: unknown, ttlSeconds = defaultTtlSeconds, staleTtlSeconds = 0) {
      const currentTime = now();
      sweepExpired(currentTime);
      if (cache.has(key)) cache.delete(key);
      const expires = currentTime + ttlSeconds * 1000;
      cache.set(key, {
        value,
        expires,
        staleUntil: expires + Math.max(0, Number(staleTtlSeconds) || 0) * 1000,
      });
      // ponytail: FIFO cap; switch to measured LRU only if cache churn becomes material.
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      scheduleIdleSweep(registration);
    },
    delete(key: unknown) {
      cache.delete(key);
    },
    flushAll() {
      cache.clear();
    },
  };
}
