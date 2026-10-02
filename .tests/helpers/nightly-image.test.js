import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { getPublishedNightlyImage } from "../../lib/nightly-image.js";
import { promoteNightlyImage } from "../../lib/nightly-publication.js";
import { selectNightlyUpdate } from "../../lib/release-version.js";

const repository = "example/aurral";
const digest = `sha256:${"a".repeat(64)}`;
const oldSha = "29523ef";
const newSha = "e1e5f04";

function registry(t, version, { indexed = true, status = 200 } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url).includes("/token?")) return Response.json({ token: "disposable" });
    if (String(url).endsWith("/manifests/nightly")) {
      if (status !== 200) return new Response("", { status });
      if (indexed) return Response.json({ manifests: [
        { digest: `sha256:${"b".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" } },
        { digest, platform: { os: "linux", architecture: "amd64" } },
      ] });
    }
    if (String(url).includes("/manifests/")) return Response.json({ config: { digest } });
    if (String(url).includes("/blobs/")) return Response.json({ config: { Env: [`APP_VERSION=${version}`] } });
    throw new Error(`Unexpected registry request ${url}`);
  });
  return requests;
}

test("nightly discovery follows the published image, ignoring newer unpublished source commits", async (t) => {
  const requests = registry(t, `nightly.382+${oldSha}`);
  const published = await getPublishedNightlyImage(repository);
  assert.deepEqual(published, { version: `nightly.382+${oldSha}`, sha: oldSha });
  assert.equal(selectNightlyUpdate(`nightly.382+${oldSha}`, published.sha), null);
  assert.ok(requests.some((url) => url.endsWith(`/manifests/${digest}`)));
  assert.ok(requests.every((url) => !url.includes("api.github.com")));
});

test("nightly discovery supports a single manifest and reports a published update", async (t) => {
  registry(t, `nightly.383+${newSha}`, { indexed: false });
  const published = await getPublishedNightlyImage(repository);
  assert.deepEqual(selectNightlyUpdate(`nightly.382+${oldSha}`, published.sha), {
    current: oldSha, latest: newSha,
  });
});

test("nightly discovery distinguishes a missing tag from registry failures and invalid versions", async (t) => {
  registry(t, "", { status: 404 });
  assert.equal(await getPublishedNightlyImage(repository), null);
  t.mock.restoreAll();
  registry(t, "", { status: 503 });
  await assert.rejects(getPublishedNightlyImage(repository), /503/);
  t.mock.restoreAll();
  registry(t, "unknown");
  await assert.rejects(getPublishedNightlyImage(repository), /version/);
});

for (const status of ["behind", "diverged"]) {
  test(`nightly promotion leaves the published image untouched when the candidate is ${status}`, async (t) => {
    registry(t, `nightly.381+${newSha}`);
    const calls = [];
    t.mock.method(childProcess, "execFileSync", (command) => {
      calls.push(command);
      assert.equal(command, "gh");
      return status;
    });
    assert.equal(await promoteNightlyImage({ repository, sha: oldSha, digest }), false);
    assert.deepEqual(calls, ["gh"]);
  });
}

test("nightly promotion promotes a newer commit by digest, regardless of its run number", async (t) => {
  registry(t, `nightly.382+${oldSha}`);
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push({ command, args });
    return command === "gh" ? "ahead" : "";
  });
  assert.equal(await promoteNightlyImage({ repository, sha: newSha, digest }), true);
  assert.deepEqual(calls[1], {
    command: "docker",
    args: ["buildx", "imagetools", "create", "--tag", `ghcr.io/${repository}:nightly`, `ghcr.io/${repository}@${digest}`],
  });
});

test("nightly promotion supports the first publication and rebuilding the same commit", async (t) => {
  registry(t, "", { status: 404 });
  const commands = [];
  t.mock.method(childProcess, "execFileSync", (command) => {
    commands.push(command);
    return "";
  });
  assert.equal(await promoteNightlyImage({ repository, sha: newSha, digest }), true);
  assert.deepEqual(commands, ["docker"]);
  t.mock.restoreAll();
  registry(t, `nightly.381+${newSha}`);
  t.mock.method(childProcess, "execFileSync", (command) => {
    commands.push(command);
    return command === "gh" ? "identical" : "";
  });
  assert.equal(await promoteNightlyImage({ repository, sha: newSha, digest }), true);
  assert.deepEqual(commands, ["docker", "gh", "docker"]);
});

test("nightly promotion fails closed when registry or ancestry checks fail", async (t) => {
  registry(t, "", { status: 503 });
  t.mock.method(childProcess, "execFileSync", () => assert.fail("Must not publish"));
  await assert.rejects(promoteNightlyImage({ repository, sha: newSha, digest }), /503/);
  t.mock.restoreAll();
  registry(t, `nightly.382+${oldSha}`);
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("GitHub unavailable"); });
  await assert.rejects(promoteNightlyImage({ repository, sha: newSha, digest }), /GitHub unavailable/);
});
