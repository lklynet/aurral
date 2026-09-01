const createAbortError = () => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

const getAbortReason = (signal) => signal?.reason || createAbortError();

const createTimeoutError = () => {
  const error = new Error("Rate limiter request deadline exceeded");
  error.code = "ETIMEDOUT";
  return error;
};

const createQueueFullError = () => {
  const error = new Error("Rate limiter queue is full");
  error.code = "EQUEUEFULL";
  return error;
};

export default function createRateLimiter(minTime, { maxQueue = Infinity } = {}) {
  const intervalMs = Math.max(0, Number(minTime) || 0);
  const queueLimit = Number.isFinite(maxQueue)
    ? Math.max(0, Math.floor(maxQueue))
    : Infinity;
  const queue = [];
  let lastCall = 0;
  let draining = false;
  let pendingReservations = 0;

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry.settled) continue;

      const wait = Math.max(0, intervalMs - (Date.now() - lastCall));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (entry.settled) continue;

      const remainingMs = entry.deadline == null ? undefined : entry.deadline - Date.now();
      if (remainingMs != null && remainingMs <= 0) {
        entry.cancel(createTimeoutError());
        continue;
      }

      entry.started = true;
      pendingReservations -= 1;
      lastCall = Date.now();
      entry.cleanup();
      let result;
      try {
        result = entry.fn(remainingMs);
      } catch (error) {
        entry.reject(error);
        continue;
      }
      Promise.resolve(result).then(entry.resolve, entry.reject);
    }
    draining = false;
    if (queue.length > 0) void drain();
  };

  const schedule = (fn, { signal, timeoutMs } = {}) => {
    if (typeof fn !== "function") {
      return Promise.reject(new TypeError("Rate limiter callback must be a function"));
    }
    if (signal?.aborted) return Promise.reject(getAbortReason(signal));
    if (pendingReservations >= queueLimit) return Promise.reject(createQueueFullError());

    pendingReservations += 1;

    const parsedTimeoutMs = Number(timeoutMs);
    const deadline = Number.isFinite(parsedTimeoutMs)
      ? Date.now() + Math.max(0, parsedTimeoutMs)
      : null;
    let entry;

    const promise = new Promise((resolve, reject) => {
      entry = {
        deadline,
        started: false,
        settled: false,
        timeout: null,
        onAbort: null,
        cleanup() {
          if (entry.timeout) clearTimeout(entry.timeout);
          if (entry.onAbort) signal?.removeEventListener("abort", entry.onAbort);
          entry.timeout = null;
          entry.onAbort = null;
        },
        resolve: (value) => {
          if (entry.settled) return;
          entry.settled = true;
          entry.cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (entry.settled) return;
          entry.settled = true;
          entry.cleanup();
          reject(error);
        },
        cancel: (error) => {
          if (entry.settled) return;
          if (!entry.started) pendingReservations -= 1;
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          entry.reject(error);
        },
        fn,
      };

      if (signal) {
        entry.onAbort = () => entry.cancel(getAbortReason(signal));
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (deadline != null) {
        entry.timeout = setTimeout(
          () => entry.cancel(createTimeoutError()),
          Math.max(0, deadline - Date.now()),
        );
      }
      queue.push(entry);
      void drain();
    });

    return promise;
  };

  return {
    schedule,
    wrap(fn) {
      return (...args) => schedule(() => fn(...args));
    },
  };
}
