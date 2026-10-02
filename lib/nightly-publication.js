import childProcess from "node:child_process";
import { getPublishedNightlyImage } from "./nightly-image.js";

export async function promoteNightlyImage({ repository, sha, digest }) {
  if (!/^[0-9a-f]{7,40}$/.test(sha || "") || !/^sha256:[0-9a-f]{64}$/.test(digest || "")) {
    throw new Error("Invalid nightly publication commit or digest");
  }
  const published = await getPublishedNightlyImage(repository);
  if (published) {
    const status = childProcess.execFileSync("gh", [
      "api", `repos/${repository}/compare/${published.sha}...${sha}`, "--jq", ".status",
    ], { encoding: "utf8" }).trim();
    if (status === "behind" || status === "diverged") return false;
    if (status !== "ahead" && status !== "identical") {
      throw new Error("Could not establish nightly commit ancestry");
    }
  }
  childProcess.execFileSync("docker", [
    "buildx", "imagetools", "create", "--tag", `ghcr.io/${repository}:nightly`,
    `ghcr.io/${repository}@${digest}`,
  ], { stdio: "inherit" });
  return true;
}
