export default function createCache(
  defaultTtlSeconds = 300,
  maxEntries = 1000,
  { now = () => Date.now() } = {},
) {
  const cache = new Map();

  return {
    get(key) {
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires < now()) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    getWithStale(key) {
      const entry = cache.get(key);
      if (entry === undefined) return undefined;
      const currentTime = now();
      if (entry.expires >= currentTime) {
        return { value: entry.value, stale: false };
      }
      if (entry.staleUntil > currentTime) {
        return { value: entry.value, stale: true };
      }
      cache.delete(key);
      return undefined;
    },
    set(key, value, ttlSeconds = defaultTtlSeconds, staleTtlSeconds = 0) {
      if (cache.has(key)) cache.delete(key);
      const expires = now() + ttlSeconds * 1000;
      cache.set(key, {
        value,
        expires,
        staleUntil: expires + Math.max(0, Number(staleTtlSeconds) || 0) * 1000,
      });
      // ponytail: FIFO cap; switch to measured LRU only if cache churn becomes material.
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    },
    delete(key) {
      cache.delete(key);
    },
    flushAll() {
      cache.clear();
    },
  };
}
