import test from "node:test";
import assert from "node:assert/strict";

import {
  compareReleaseVersions,
  parseReleaseVersion,
  selectLatestReleaseForChannel,
} from "../../frontend/src/utils/releaseVersion.js";

test("parseReleaseVersion identifies stable and test channels", () => {
  assert.deepEqual(parseReleaseVersion("v1.50.0"), {
    raw: "v1.50.0",
    label: "1.50.0",
    major: 1,
    minor: 50,
    patch: 0,
    prerelease: null,
    channel: "stable",
  });

  assert.deepEqual(parseReleaseVersion("1.51.0-test.1"), {
    raw: "1.51.0-test.1",
    label: "1.51.0-test.1",
    major: 1,
    minor: 51,
    patch: 0,
    prerelease: 1,
    channel: "test",
  });
});

test("compareReleaseVersions orders stable and test semver values", () => {
  assert.equal(compareReleaseVersions("1.50.0", "1.49.0"), 1);
  assert.equal(compareReleaseVersions("1.51.0-test.1", "1.50.0-test.9"), 1);
  assert.equal(compareReleaseVersions("1.50.0", "1.50.0-test.7"), 1);
});

test("parseReleaseVersion identifies dev channel tags", () => {
  assert.deepEqual(parseReleaseVersion("1.51.0-dev.2"), {
    raw: "1.51.0-dev.2",
    label: "1.51.0-dev.2",
    major: 1,
    minor: 51,
    patch: 0,
    prerelease: 2,
    channel: "dev",
  });
});

test("selectLatestReleaseForChannel separates stable, test, and dev tags", () => {
  const refs = [
    { ref: "refs/tags/v1.50.0" },
    { ref: "refs/tags/v1.51.0-test.1" },
    { ref: "refs/tags/v1.51.0-dev.2" },
    { ref: "refs/tags/v1.50.0-test.1" },
    { ref: "refs/tags/v1.49.0" },
  ];

  assert.equal(selectLatestReleaseForChannel(refs, "stable")?.tagName, "v1.50.0");
  assert.equal(
    selectLatestReleaseForChannel(refs, "test")?.tagName,
    "v1.51.0-test.1",
  );
  assert.equal(
    selectLatestReleaseForChannel(refs, "dev")?.tagName,
    "v1.51.0-dev.2",
  );
});
