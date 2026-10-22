import { setTimeout as wait } from "node:timers/promises";
import { asAppError } from "../../lib/errors.ts";

type MonitoredEntity = { monitored?: boolean } | null;
type MonitoringRepairResult = { artist?: MonitoredEntity; album?: MonitoredEntity } | null;

const isMonitoringComplete = (result: MonitoringRepairResult) =>
  Boolean(result?.artist && result?.album) &&
  result!.artist!.monitored !== false &&
  result!.album!.monitored !== false;

export const runMonitoringRepairSequence = async ({
  repair,
  delaysMs = [1_000, 3_000, 8_000, 15_000],
}: {
  repair?: () => MonitoringRepairResult | Promise<MonitoringRepairResult>;
  delaysMs?: number[];
} = {}) => {
  if (typeof repair !== "function") {
    throw new TypeError("repair must be a function");
  }

  let lastResult = null;
  let lastError: Error | null = null;
  for (const delayMs of delaysMs) {
    await wait(delayMs, undefined, { ref: false });
    try {
      lastResult = await repair();
      lastError = null;
      if (isMonitoringComplete(lastResult)) {
        return { complete: true, result: lastResult };
      }
    } catch (error) {
      lastError = asAppError(error) ?? null;
    }
  }

  return { complete: false, result: lastResult, error: lastError };
};
