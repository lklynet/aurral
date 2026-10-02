import { getPublishedNightlyImage } from "../../lib/nightly-image.js";

let cached;
let expiresAt = 0;

export function getLatestNightlyImage() {
  if (cached && Date.now() < expiresAt) return cached;
  expiresAt = Date.now() + 10 * 60 * 1000;
  cached = getPublishedNightlyImage(process.env.GITHUB_REPO || "lklynet/aurral").catch(() => {
    expiresAt = Date.now() + 60 * 1000;
    throw new Error("Published nightly image could not be checked");
  });
  return cached;
}
