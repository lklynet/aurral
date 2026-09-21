import sharp from "sharp";

const SHARP_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.floor(Number(process.env.AURRAL_SHARP_CONCURRENCY) || 2)),
);

sharp.concurrency(SHARP_CONCURRENCY);
sharp.cache({
  memory: 32,
  files: 20,
  items: 100,
});

export default sharp;
