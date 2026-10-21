const createAbortError = () => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

const getAbortReason = (signal) => signal?.reason || createAbortError();

export const runSharedInflight = (inflight, key, task, { signal } = {}) => {
  if (!(inflight instanceof Map)) {
    throw new TypeError("inflight must be a Map");
  }
  if (typeof task !== "function") {
    throw new TypeError("task must be a function");
  }
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      consumers: new Set(),
      settled: false,
      promise: null,
    };
    let taskResult;
    try {
      taskResult = task(controller.signal);
    } catch (error) {
      taskResult = Promise.reject(error);
    }
    entry.promise = Promise.resolve(taskResult).finally(() => {
      entry.settled = true;
      if (inflight.get(key) === entry) {
        inflight.delete(key);
      }
    });
    inflight.set(key, entry);
  }

  const consumer = {};
  entry.consumers.add(consumer);

  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      entry.consumers.delete(consumer);
      if (!entry.settled && entry.consumers.size === 0) {
        entry.controller.abort(createAbortError());
      }
    };
    const onAbort = () => {
      release();
      reject(getAbortReason(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (finished) return;
        release();
        resolve(value);
      },
      (error) => {
        if (finished) return;
        release();
        reject(error);
      },
    );
  });
};
