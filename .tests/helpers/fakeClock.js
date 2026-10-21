import { afterEach, beforeEach, vi } from "vite-plus/test";

export function useFakeClock() {
  let now = Date.now();
  let stopClock = async () => {};
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now,
    });
    let running = true;
    const ticking = (async () => {
      while (running) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(10);
      }
    })();
    stopClock = async () => {
      running = false;
      await ticking;
    };
  });
  afterEach(async () => {
    await stopClock();
    await vi.runAllTimersAsync();
    now = Date.now();
  });
}
