import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  compareReleaseVersions,
  extractReleaseNoteItems,
  parseNightlyVersion,
  parseReleaseVersion,
  releaseChannel,
  resolveNextRelease,
  selectLatestRelease,
  suggestNextVersion,
} from "../../lib/release-version.ts";

test("parseReleaseVersion accepts stable versions and rejects legacy prerelease tags", () => {
  assert.deepEqual(parseReleaseVersion("v1.50.0"), {
    raw: "v1.50.0",
    label: "1.50.0",
    major: 1,
    minor: 50,
    patch: 0,
  });

  assert.equal(parseReleaseVersion("1.51.0-test.1"), null);
  assert.equal(parseReleaseVersion("1.51.0-dev.2"), null);
  assert.equal(parseReleaseVersion("2.0"), null);
});

test("compareReleaseVersions orders by major, then minor, then patch", () => {
  assert.equal(compareReleaseVersions("1.50.0", "1.49.0"), 1);
  assert.equal(compareReleaseVersions("2.0.0", "10.0.0") < 0, true);
  assert.equal(compareReleaseVersions("1.50.1", "1.50.1"), 0);
});

test("selectLatestRelease picks the newest stable tag and ignores legacy prerelease tags", () => {
  const refs = [
    { ref: "refs/tags/v2.0.0" },
    { ref: "refs/tags/v2.1.0-test.1" },
    { ref: "refs/tags/v2.1.0-dev.2" },
    { ref: "refs/tags/v1.49.0" },
  ];

  assert.equal(selectLatestRelease(refs)?.tagName, "v2.0.0");
  assert.equal(selectLatestRelease([{ ref: "refs/tags/v2.1.0-dev.2" }]), null);
});

test("releaseChannel recognizes stable and nightly builds only", () => {
  assert.deepEqual(parseNightlyVersion("nightly.512+a1b2c3d"), { run: 512, sha: "a1b2c3d" });
  assert.equal(releaseChannel("2.10.0"), "stable");
  assert.equal(releaseChannel("nightly.512+a1b2c3d"), "nightly");
  assert.equal(releaseChannel("pr.12+a1b2c3d"), null);
  assert.equal(releaseChannel("ci-a1b2c3d4e5f6"), null);
  assert.equal(releaseChannel("a1b2c3d"), null);
});

test("extractReleaseNoteItems keeps concise markdown change items", () => {
  assert.deepEqual(
    extractReleaseNoteItems(
      "## What's Changed\n### Fixes\n* fix: repair imports by @a in https://github.com/aurral/pull/1\n* [Add search](https://example.com)\n\n**Full Changelog**: https://example.com/compare",
    ),
    ["fix: repair imports by @a", "Add search"],
  );
});

test("suggestNextVersion bumps according to Conventional Commit titles", () => {
  const tags = ["v2.0.0", "v2.0.1", "v1.9.0"];

  assert.equal(suggestNextVersion(tags, ["fix: repair import", "docs: tidy"]), "2.0.2");
  assert.equal(suggestNextVersion(tags, ["fix: repair import", "feat(ui): add sharing"]), "2.1.0");
  assert.equal(suggestNextVersion(tags, ["fix: a", "feat!: drop old config", "feat: b"]), "3.0.0");
  assert.equal(suggestNextVersion([], ["feat: first"]), "0.1.0");
});

test("resolveNextRelease publishes the requested stable version", () => {
  assert.deepEqual(
    resolveNextRelease({ targetVersion: "2.1.0", allTags: ["v2.0.0", "v2.0.1-dev.4"] }),
    { tag: "v2.1.0", version: "2.1.0", reusedExistingTag: false },
  );
});

test("resolveNextRelease reuses the tag at HEAD when a workflow is rerun", () => {
  assert.deepEqual(
    resolveNextRelease({
      targetVersion: "2.1.0",
      allTags: ["v2.0.0", "v2.1.0"],
      headTags: ["v2.1.0"],
    }),
    { tag: "v2.1.0", version: "2.1.0", reusedExistingTag: true },
  );
});

test("resolveNextRelease rejects a version already tagged on another commit", () => {
  assert.throws(
    () => resolveNextRelease({ targetVersion: "2.1.0", allTags: ["v2.1.0"], headTags: ["v2.0.0"] }),
    /already exists on another commit/,
  );
});

test("resolveNextRelease rejects a version that is not newer than the latest stable", () => {
  assert.throws(
    () => resolveNextRelease({ targetVersion: "1.9.0", allTags: ["v2.0.0"] }),
    /must be newer than latest stable/,
  );
});

test("resolveNextRelease rejects malformed and prerelease targets", () => {
  for (const targetVersion of ["", "next", "2.0", "2.0.0-rc.1"]) {
    assert.throws(() => resolveNextRelease({ targetVersion }), /must be a stable semantic version/);
  }
});
