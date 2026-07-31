#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

import {
  resolveNextRelease,
  selectLatestRelease,
  suggestNextVersion,
} from "../lib/release-version.js";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function toLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const allTags = toLines(git("tag", "--list"));
const headTags = toLines(git("tag", "--points-at", "HEAD"));
const latestStable = selectLatestRelease(allTags);
const subjects = toLines(
  git("log", "--format=%s", latestStable ? `${latestStable.tagName}..HEAD` : "HEAD"),
);

const requestedVersion = String(process.env.REQUESTED_VERSION || "").trim();
const targetVersion = requestedVersion || suggestNextVersion(allTags, subjects);

const release = resolveNextRelease({ targetVersion, allTags, headTags });
const [major, minor] = release.version.split(".");

console.log(
  requestedVersion
    ? `Publishing requested version ${release.version}.`
    : `Publishing ${release.version}, suggested from ${subjects.length} commits since ${latestStable?.tagName || "the first commit"}.`,
);

if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `tag=${release.tag}`,
    `version=${release.version}`,
    `major=${major}`,
    `minor=${major}.${minor}`,
    `reused_existing_tag=${String(release.reusedExistingTag)}`,
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}
