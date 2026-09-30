import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
const [state, { slskdClient }] = await setupIsolatedBackend("slskd-search-polling", "backend/services/slskdClient.js");
test.after(() => cleanupIsolatedState(state));

test("searchQuery returns before a second settlement window begins", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  t.mock.method(slskdClient, "createSearch", async () => ({ id: "owned-empty-search" }));
  t.mock.method(slskdClient, "deleteSearch", async () => true);
  let polls = 0;
  t.mock.method(slskdClient, "getSearch", async () => {
    if (++polls > 2) t.mock.timers.setTime(121000);
    return { state: polls > 2 ? "Completed" : "InProgress", responses: [] };
  });
  const pending = slskdClient.searchQuery("Artist First", { timeoutMs: 10000 });
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  const result = await pending;
  assert.deepEqual(result, []);
  assert.ok(Date.now() <= 11000, "empty cutoff must not add a settlement window");
});

test("completed-search hydration stays inside the collection deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  t.mock.method(slskdClient, "getSearch", async () => ({ state: "Completed", fileCount: 1, responses: [] }));
  t.mock.method(slskdClient, "getSearchResponses", async () => []);
  let finishedAt;
  const pending = slskdClient.waitForSearch("owned-hydrating-search", 1000, { gracePeriodMs: 0 })
    .then((result) => { finishedAt = Date.now(); return result; });
  await new Promise(setImmediate);
  for (let step = 0; step < 32; step++) {
    t.mock.timers.tick(500);
    await new Promise(setImmediate);
  }
  assert.ok(await pending);
  assert.ok(finishedAt <= 2000, "hydration must share the collection deadline");
});

test("partial Soulseek snapshots retain earlier files and updated lock metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let poll = 0;
  t.mock.method(slskdClient, "getSearch", async () => ++poll === 1
    ? { state: "InProgress", responses: [{ username: "peer", files: [{ filename: "First.flac" }, { filename: "Second.flac" }] }] }
    : { state: "Completed", responses: [{ username: "peer", lockedFiles: [{ filename: "Second.flac" }] }] });
  const pending = slskdClient.waitForSearch("partial-snapshot", 10000);
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  const result = slskdClient.flattenSearchResults(await pending);
  assert.equal(result.length, 2);
  assert.equal(result.find((file) => file.file === "Second.flac").locked, true);
});

test("unchanged polling snapshots do not hide same-count lock updates", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { SlskdClient } = await import("../../backend/services/slskdClient.js");
  const client = new SlskdClient({ enabled: true, url: "http://service.invalid" });
  let polls = 0;
  t.mock.method(client, "getSearch", async () => ({ state: "InProgress", fileCount: 1,
    responses: [{ username: "peer", files: [{ filename: "First.flac", isLocked: ++polls < 3 }] }] }));
  t.mock.method(client, "deleteSearch", async () => true);
  const pending = client.waitForSearch("same-count-update", 60000, {
    earlyExitWhen: (data) => client.flattenSearchResults(data).some((file) => !file.locked),
  });
  await new Promise(setImmediate);
  for (let step = 0; step < 10 && polls < 3; step++) {
    t.mock.timers.tick(5000);
    await new Promise(setImmediate);
  }
  const files = client.flattenSearchResults(await pending);
  assert.equal(files.length, 1);
  assert.equal(files[0].locked, false);
});

test("a request expiring at the collection deadline preserves collected results", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let polls = 0;
  t.mock.method(slskdClient, "getSearch", async () => {
    if (++polls > 1) { t.mock.timers.setTime(11000); throw new Error("request timed out"); }
    return { state: "InProgress", responses: [{ username: "peer", files: [{ filename: "First.flac" }] }] };
  });
  t.mock.method(slskdClient, "deleteSearch", async () => true);
  const pending = slskdClient.waitForSearch("deadline-with-results", 10000, { gracePeriodMs: 0 });
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  const files = slskdClient.flattenSearchResults(await pending);
  assert.deepEqual(files.map((file) => file.file), ["First.flac"]);
});

test("changing provider progress does not reassess unchanged files", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let polls = 0;
  let assessments = 0;
  t.mock.method(slskdClient, "getSearch", async () => ({
    state: ++polls === 3 ? "Completed" : "InProgress", elapsed: polls,
    responses: [{ username: "peer", files: [{ filename: "First.flac" }] }],
  }));
  const pending = slskdClient.waitForSearch("progress-only", 60000, {
    earlyExitWhen: () => { assessments++; return false; },
  });
  for (let step = 0; step < 3; step++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(5000);
  }
  assert.equal(slskdClient.flattenSearchResults(await pending).length, 1);
  assert.equal(assessments, 1);
});

test("completed counts hydrate files missing from earlier snapshots", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let polls = 0;
  t.mock.method(slskdClient, "getSearch", async () => ++polls === 1
    ? { state: "InProgress", responses: [{ username: "peer", files: [{ filename: "First.flac" }] }] }
    : { state: "Completed", fileCount: 2, responses: [] });
  t.mock.method(slskdClient, "getSearchResponses", async () => [{ username: "peer", files: [{ filename: "Second.flac" }] }]);
  const pending = slskdClient.waitForSearch("missing-final-file", 60000);
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  const files = slskdClient.flattenSearchResults(await pending);
  assert.deepEqual(files.map((file) => file.file).sort(), ["First.flac", "Second.flac"]);
});
