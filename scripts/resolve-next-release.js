#!/usr/bin/env node

import { nextPatchVersion, resolveNextRelease } from "../lib/release-version.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const args = parseArgs(process.argv.slice(2));
const branch = args.branch || process.env.GITHUB_REF_NAME || "";
const allTags = splitCsv(args.tags || process.env.RELEASE_TAGS);
const headTags = splitCsv(args["head-tags"] || process.env.HEAD_RELEASE_TAGS);
const targetVersion =
  args["target-version"] || process.env.TARGET_RELEASE_VERSION || nextPatchVersion(allTags);
const githubOutputPath = args["github-output"] === "true" ? process.env.GITHUB_OUTPUT : "";

if (!branch) {
  console.error("Missing required --branch value.");
  process.exit(1);
}

const release = resolveNextRelease({
  branch,
  targetVersion,
  allTags,
  headTags,
});

if (!release) {
  console.error(`Branch "${branch}" is not release-enabled.`);
  process.exit(1);
}

if (githubOutputPath) {
  const lines = [
    `tag=${release.tag}`,
    `version=${release.version}`,
    `channel=${release.channel}`,
    `is_prerelease=${String(release.isPrerelease)}`,
    `make_latest=${String(release.makeLatest)}`,
    `reused_existing_tag=${String(release.reusedExistingTag)}`,
  ];
  await import("node:fs/promises").then(({ appendFile }) =>
    appendFile(githubOutputPath, `${lines.join("\n")}\n`, "utf8"),
  );
} else {
  process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
}
