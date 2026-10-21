const SHARP_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.floor(Number(process.env.AURRAL_SHARP_CONCURRENCY) || 2)),
);

let sharpReady;

export default function getSharp() {
  return (sharpReady ||= import("sharp").then(({ default: sharp }) => {
    sharp.concurrency(SHARP_CONCURRENCY);
    sharp.cache(false);
    return sharp;
  }));
}
