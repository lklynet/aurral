import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getPublishedNightlyImage } from "../lib/nightly-image.js";

const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
const sha = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{7,40}$/.test(sha || "")) {
  throw new Error("Invalid nightly publication commit");
}
const published = await getPublishedNightlyImage(repository);
let publish = true;
if (published) {
  const status = execFileSync("gh", [
    "api", `repos/${repository}/compare/${published.sha}...${sha}`, "--jq", ".status",
  ], { encoding: "utf8" }).trim();
  if (!["ahead", "identical", "behind", "diverged"].includes(status)) {
    throw new Error("Could not establish nightly commit ancestry");
  }
  publish = status === "ahead" || status === "identical";
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
}
console.log(publish ? "Nightly candidate can be published." : "Skipped older nightly candidate.");
