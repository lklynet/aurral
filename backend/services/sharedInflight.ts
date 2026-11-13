const createAbortError = () => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

type InflightEntry = {
  controller: AbortController;
  consumers: Set<object>;
  abortWhenUnused: boolean;
  settled: boolean;
  promise: Promise<unknown> | null;
};

export type InflightRequests = Map<string, InflightEntry>;

const getAbortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason || createAbortError();

export const runSharedInflight = <T>(
  inflight: InflightRequests,
  key: string,
  task: (signal: AbortSignal) => T,
  { signal, abortWhenUnused = true }: { signal?: AbortSignal; abortWhenUnused?: boolean } = {},
): Promise<Awaited<T>> => {
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      consumers: new Set(),
      abortWhenUnused,
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
      entry!.settled = true;
      if (inflight.get(key) === entry) {
        inflight.delete(key);
      }
    });
    inflight.set(key, entry);
  } else if (!abortWhenUnused) {
    entry.abortWhenUnused = false;
  }

  const consumer = {};
  entry.consumers.add(consumer);

  return new Promise<Awaited<T>>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      entry.consumers.delete(consumer);
      if (entry.abortWhenUnused && !entry.settled && entry.consumers.size === 0) {
        entry.controller.abort(createAbortError());
      }
    };
    const onAbort = () => {
      release();
      reject(getAbortReason(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise!.then(
      (value) => {
        if (finished) return;
        release();
        // A key only ever runs one kind of task, so its result has that task's type.
        resolve(value as Awaited<T>);
      },
      (error) => {
        if (finished) return;
        release();
        reject(error);
      },
    );
  });
};
