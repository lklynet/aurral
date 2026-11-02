const MIN_DURATION = 30;
const MAX_LISTEN = 240;

export function createPlayTracker() {
  let listened = 0;
  let lastTime: number | null = null;
  let counted = false;
  return {
    seeking() {
      lastTime = null;
    },
    update(time: number, duration: number) {
      if (lastTime !== null && time > lastTime) listened += time - lastTime;
      lastTime = time;
      if (counted || !(duration > MIN_DURATION)) return false;
      counted = listened >= Math.min(duration / 2, MAX_LISTEN);
      return counted;
    },
  };
}
