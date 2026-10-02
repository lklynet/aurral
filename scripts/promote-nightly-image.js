import { appendFileSync } from "node:fs";
import { promoteNightlyImage } from "../lib/nightly-publication.js";

const promoted = await promoteNightlyImage({
  repository: process.env.GITHUB_REPOSITORY?.toLowerCase(),
  sha: process.env.GITHUB_SHA,
  digest: process.env.NIGHTLY_DIGEST,
});
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `promoted=${promoted}\n`);
}
console.log(promoted ? "Published nightly image." : "Skipped older nightly candidate.");
