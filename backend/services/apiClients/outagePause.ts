import { HttpError } from "../../../lib/http.ts";
import { logger } from "../logger.ts";

const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 60_000;

const pauses = new Set<{ resume(): void }>();

export function createOutagePause(service: string) {
  let failuresInARow = 0;
  let pausedUntil = 0;
  const pause = {
    paused: () => Date.now() < pausedUntil,
    check() {
      if (!pause.paused()) return;
      throw new HttpError(
        `${service} is not responding`,
        { method: "GET", url: service },
        { code: "PAUSED" },
      );
    },
    async run<T>(request: () => Promise<T>) {
      pause.check();
      try {
        const result = await request();
        failuresInARow = 0;
        return result;
      } catch (error) {
        if (!(error instanceof HttpError) || error.response || error.code === "ABORTED") {
          failuresInARow = 0;
        } else if (++failuresInARow >= PAUSE_AFTER_FAILURES) {
          failuresInARow = 0;
          pausedUntil = Date.now() + PAUSE_MS;
          logger.warn("api", `${service} is not responding, pausing requests for a minute`, {
            code: error.code ?? null,
            message: error.message,
          });
        }
        throw error;
      }
    },
    resume() {
      failuresInARow = 0;
      pausedUntil = 0;
    },
  };
  pauses.add(pause);
  return pause;
}

export function resumePausedServices() {
  for (const pause of pauses) pause.resume();
}
