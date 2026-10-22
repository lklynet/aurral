import { execFileSync } from "node:child_process";
import { normalizeReleaseVersion, parseReleaseVersion } from "./release-version.ts";

function runGit(args, cwd = process.cwd()) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function getExactReleaseVersionAtHead(cwd = process.cwd()) {
  const tags = runGit(["tag", "--points-at", "HEAD"], cwd)
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  const releaseTag = tags.find((tag) => parseReleaseVersion(tag));
  return releaseTag ? normalizeReleaseVersion(releaseTag) : "";
}

export function getShortGitSha(cwd = process.cwd()) {
  return runGit(["rev-parse", "--short", "HEAD"], cwd);
}

export function resolveAppVersion({ envValue, cwd = process.cwd(), fallback = "unknown" } = {}) {
  const normalizedEnv = String(envValue || "").trim();
  if (normalizedEnv) {
    return normalizeReleaseVersion(normalizedEnv);
  }

  const exactReleaseVersion = getExactReleaseVersionAtHead(cwd);
  if (exactReleaseVersion) {
    return exactReleaseVersion;
  }

  const shortSha = getShortGitSha(cwd);
  if (shortSha) {
    return shortSha;
  }

  return fallback;
}
