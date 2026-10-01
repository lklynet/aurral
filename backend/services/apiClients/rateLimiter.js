import PQueue from "p-queue";

const createError = (message, code) => Object.assign(new Error(message), { code });

export default function createRateLimiter(minTime, { maxQueue = Infinity } = {}) {
  const queue = new PQueue({ interval: Math.max(0, Number(minTime) || 0), intervalCap: 1, strict: Number(minTime) > 0 });

  const schedule = (fn, { signal, timeoutMs } = {}) => {
    if (typeof fn !== "function") {
      return Promise.reject(new TypeError("Rate limiter callback must be a function"));
    }
    if (queue.size >= maxQueue) {
      return Promise.reject(createError("Rate limiter queue is full", "EQUEUEFULL"));
    }

    const parsedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(parsedTimeoutMs)) return queue.add(() => fn(), { signal });

    const deadline = Date.now() + Math.max(0, parsedTimeoutMs);
    const expired = new AbortController();
    const timer = setTimeout(
      () => expired.abort(createError("Rate limiter request deadline exceeded", "ETIMEDOUT")),
      Math.max(0, parsedTimeoutMs),
    );
    const signals = signal ? [signal, expired.signal] : [expired.signal];
    return queue
      .add(() => {
        clearTimeout(timer);
        return fn(deadline - Date.now());
      }, { signal: AbortSignal.any(signals) })
      .finally(() => clearTimeout(timer));
  };

  return {
    schedule,
    wrap(fn) {
      return (...args) => schedule(() => fn(...args));
    },
  };
}
