import { logger } from "./logger.ts";

const CHECK_MS = 500;
const STALL_MS = 1000;
const WARN_STALL_MS = 5000;
const MAX_LISTED = 10;

type Work = { describe: () => string };
const running = new Set<Work>();
const finishedDuringStall: Work[] = [];
let lastCheck: number | null = null;

export async function trackWork<T>(describe: () => string, run: () => Promise<T>) {
  const entry = { describe };
  running.add(entry);
  try {
    return await run();
  } finally {
    running.delete(entry);
    if (lastCheck !== null && performance.now() - lastCheck >= CHECK_MS + STALL_MS) {
      finishedDuringStall.push(entry);
    }
  }
}

export const cpuMs = ({ user, system }: NodeJS.CpuUsage) => Math.round((user + system) / 1000);

export function watchEventLoop() {
  lastCheck = performance.now();
  let cpu = process.cpuUsage();
  const timer = setInterval(() => {
    const now = performance.now();
    const stalledMs = Math.round(now - (lastCheck ?? now) - CHECK_MS);
    const used = process.cpuUsage(cpu);
    const work = [...finishedDuringStall, ...running];
    lastCheck = now;
    cpu = process.cpuUsage();
    finishedDuringStall.length = 0;
    if (stalledMs < STALL_MS) return;
    logger[stalledMs >= WARN_STALL_MS ? "warn" : "info"](
      "performance",
      `Stopped responding for ${(stalledMs / 1000).toFixed(1)}s`,
      {
        ms: stalledMs,
        cpuMs: cpuMs(used),
        rssMb: Math.round(process.memoryUsage.rss() / 1048576),
        running: work.slice(0, MAX_LISTED).map((entry) => entry.describe()),
      },
    );
  }, CHECK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    lastCheck = null;
    finishedDuringStall.length = 0;
  };
}
