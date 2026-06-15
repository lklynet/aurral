import test from "node:test";
import assert from "node:assert/strict";

import { resolveNextRelease } from "../../lib/release-version.js";

test("resolveNextRelease computes next stable patch from latest stable tag", () => {
  const result = resolveNextRelease({
    branch: "main",
    allTags: ["v1.76.0", "v1.75.0", "v1.76.1-test.2"],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1",
    version: "1.76.1",
    channel: "stable",
    isPrerelease: false,
    makeLatest: true,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease computes first test prerelease from latest stable tag", () => {
  const result = resolveNextRelease({
    branch: "test",
    allTags: ["v1.76.0", "v1.75.0"],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1-test.1",
    version: "1.76.1-test.1",
    channel: "test",
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease increments existing test prereleases for next stable patch", () => {
  const result = resolveNextRelease({
    branch: "test",
    allTags: [
      "v1.76.0",
      "v1.76.1-test.1",
      "v1.76.1-test.2",
      "v1.75.9",
    ],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1-test.3",
    version: "1.76.1-test.3",
    channel: "test",
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease resets test prerelease base after stable release ships", () => {
  const result = resolveNextRelease({
    branch: "test",
    allTags: ["v1.76.1", "v1.76.1-test.3", "v1.76.0"],
  });

  assert.deepEqual(result, {
    tag: "v1.76.2-test.1",
    version: "1.76.2-test.1",
    channel: "test",
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease reuses an existing head tag on reruns", () => {
  const result = resolveNextRelease({
    branch: "main",
    allTags: ["v1.76.1", "v1.76.0"],
    headTags: ["v1.76.1"],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1",
    version: "1.76.1",
    channel: "stable",
    isPrerelease: false,
    makeLatest: true,
    reusedExistingTag: true,
  });
});

test("resolveNextRelease computes first dev prerelease from latest stable tag", () => {
  const result = resolveNextRelease({
    branch: "dev",
    allTags: ["v1.76.0", "v1.75.0"],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1-dev.1",
    version: "1.76.1-dev.1",
    channel: "dev",
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease increments existing dev prereleases independently of test", () => {
  const result = resolveNextRelease({
    branch: "dev",
    allTags: [
      "v1.76.0",
      "v1.76.1-test.1",
      "v1.76.1-test.2",
      "v1.76.1-dev.1",
    ],
  });

  assert.deepEqual(result, {
    tag: "v1.76.1-dev.2",
    version: "1.76.1-dev.2",
    channel: "dev",
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  });
});

test("resolveNextRelease ignores malformed tags and can bootstrap", () => {
  const result = resolveNextRelease({
    branch: "main",
    allTags: ["nightly-build", "release-foo"],
    initialStableVersion: "1.0.0",
  });

  assert.deepEqual(result, {
    tag: "v1.0.1",
    version: "1.0.1",
    channel: "stable",
    isPrerelease: false,
    makeLatest: true,
    reusedExistingTag: false,
  });
});
