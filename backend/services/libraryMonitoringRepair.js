import { setTimeout as wait } from "node:timers/promises";

const isMonitoringComplete = (result) =>
  Boolean(result?.artist && result?.album) &&
  result.artist.monitored !== false &&
  result.album.monitored !== false;

export const runMonitoringRepairSequence = async ({
  repair,
  delaysMs = [1_000, 3_000, 8_000, 15_000],
} = {}) => {
  if (typeof repair !== "function") {
    throw new TypeError("repair must be a function");
  }

  let lastResult = null;
  let lastError = null;
  for (const delayMs of delaysMs) {
    await wait(delayMs, undefined, { ref: false });
    try {
      lastResult = await repair();
      lastError = null;
      if (isMonitoringComplete(lastResult)) {
        return { complete: true, result: lastResult };
      }
    } catch (error) {
      lastError = error;
    }
  }

  return { complete: false, result: lastResult, error: lastError };
};
