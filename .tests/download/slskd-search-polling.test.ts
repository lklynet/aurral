import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";
const [state, { slskdClient }] = await setupIsolatedBackend(
  "slskd-search-polling",
  "backend/services/slskdClient.ts",
);
afterAll(() => cleanupIsolatedState(state));

test("searchQuery returns before a second settlement window begins", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  vi.spyOn(slskdClient, "createSearch").mockImplementation(async () => ({
    id: "owned-empty-search",
  }));
  vi.spyOn(slskdClient, "deleteSearch").mockImplementation(async () => true);
  let polls = 0;
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => {
    if (++polls > 2) vi.setSystemTime(121000);
    return { state: polls > 2 ? "Completed" : "InProgress", responses: [] };
  });
  const pending = slskdClient.searchQuery("Artist First", { timeoutMs: 10000 });
  await new Promise(setImmediate);
  vi.advanceTimersByTime(10000);
  const result = await pending;
  assert.deepEqual(result, []);
  assert.ok(Date.now() <= 11000, "empty cutoff must not add a settlement window");
});

test("completed-search hydration stays inside the collection deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => ({
    state: "Completed",
    fileCount: 1,
    responses: [],
  }));
  vi.spyOn(slskdClient, "getSearchResponses").mockImplementation(async () => []);
  let finishedAt;
  const pending = slskdClient
    .waitForSearch("owned-hydrating-search", 1000, { gracePeriodMs: 0 })
    .then((result) => {
      finishedAt = Date.now();
      return result;
    });
  await new Promise(setImmediate);
  for (let step = 0; step < 32; step++) {
    vi.advanceTimersByTime(500);
    await new Promise(setImmediate);
  }
  assert.ok(await pending);
  assert.ok(finishedAt <= 2000, "hydration must share the collection deadline");
});

test("partial Soulseek snapshots retain earlier files and updated lock metadata", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  let poll = 0;
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () =>
    ++poll === 1
      ? {
          state: "InProgress",
          responses: [
            { username: "peer", files: [{ filename: "First.flac" }, { filename: "Second.flac" }] },
          ],
        }
      : {
          state: "Completed",
          responses: [{ username: "peer", lockedFiles: [{ filename: "Second.flac" }] }],
        },
  );
  const pending = slskdClient.waitForSearch("partial-snapshot", 10000);
  await new Promise(setImmediate);
  vi.advanceTimersByTime(5000);
  const result = slskdClient.flattenSearchResults(await pending);
  assert.equal(result.length, 2);
  assert.equal(result.find((file) => file.file === "Second.flac").locked, true);
});

test(
  "unchanged polling snapshots do not hide same-count lock updates",
  { timeout: 3000 },
  async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
    const { SlskdClient } = await import("../../backend/services/slskdClient.ts");
    const client = new SlskdClient({ enabled: true, url: "http://service.invalid" });
    let polls = 0;
    vi.spyOn(client, "getSearch").mockImplementation(async () => ({
      state: "InProgress",
      fileCount: 1,
      responses: [{ username: "peer", files: [{ filename: "First.flac", isLocked: ++polls < 3 }] }],
    }));
    vi.spyOn(client, "deleteSearch").mockImplementation(async () => true);
    const pending = client.waitForSearch("same-count-update", 60000, {
      earlyExitWhen: (data) => client.flattenSearchResults(data).some((file) => !file.locked),
    });
    await new Promise(setImmediate);
    for (let step = 0; step < 10 && polls < 3; step++) {
      vi.advanceTimersByTime(5000);
      await new Promise(setImmediate);
    }
    const files = client.flattenSearchResults(await pending);
    assert.equal(files.length, 1);
    assert.equal(files[0].locked, false);
  },
);

test(
  "a request expiring at the collection deadline preserves collected results",
  { timeout: 3000 },
  async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
    let polls = 0;
    vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => {
      if (++polls > 1) {
        vi.setSystemTime(11000);
        throw new Error("request timed out");
      }
      return {
        state: "InProgress",
        responses: [{ username: "peer", files: [{ filename: "First.flac" }] }],
      };
    });
    vi.spyOn(slskdClient, "deleteSearch").mockImplementation(async () => true);
    const pending = slskdClient.waitForSearch("deadline-with-results", 10000, { gracePeriodMs: 0 });
    await new Promise(setImmediate);
    vi.advanceTimersByTime(5000);
    const files = slskdClient.flattenSearchResults(await pending);
    assert.deepEqual(
      files.map((file) => file.file),
      ["First.flac"],
    );
  },
);

test("completed counts hydrate files missing from earlier snapshots", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  let polls = 0;
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () =>
    ++polls === 1
      ? {
          state: "InProgress",
          responses: [{ username: "peer", files: [{ filename: "First.flac" }] }],
        }
      : { state: "Completed", fileCount: 2, responses: [] },
  );
  vi.spyOn(slskdClient, "getSearchResponses").mockImplementation(async () => [
    { username: "peer", files: [{ filename: "Second.flac" }] },
  ]);
  const pending = slskdClient.waitForSearch("missing-final-file", 60000);
  await new Promise(setImmediate);
  vi.advanceTimersByTime(5000);
  const files = slskdClient.flattenSearchResults(await pending);
  assert.deepEqual(files.map((file) => file.file).sort(), ["First.flac", "Second.flac"]);
});

test("cancellation during final hydration stops only the owned search", async () => {
  const controller = new AbortController();
  let polls = 0;
  const deleted = [];
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => {
    if (++polls === 1) return { state: "Completed", fileCount: 1, responses: [] };
    controller.abort();
    throw new Error("request aborted during hydration");
  });
  vi.spyOn(slskdClient, "getSearchResponses").mockImplementation(async () => {
    throw new Error("responses request aborted");
  });
  vi.spyOn(slskdClient, "deleteSearch").mockImplementation(async (id) => {
    deleted.push(id);
    return true;
  });
  const result = await slskdClient.waitForSearch("owned-hydration", 60000, {
    signal: controller.signal,
  });
  assert.equal(result, null);
  assert.deepEqual(deleted, ["owned-hydration"]);
});

test("final hydration merges equal-sized partial status and response snapshots", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1000 });
  let polls = 0;
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => ({
    state: "Completed",
    fileCount: 3,
    responses: [
      { username: "peer", files: [{ filename: ++polls === 1 ? "First.flac" : "Second.flac" }] },
    ],
  }));
  vi.spyOn(slskdClient, "getSearchResponses").mockImplementation(async () => {
    vi.setSystemTime(61000);
    return [{ username: "peer", files: [{ filename: "Third.flac" }] }];
  });
  const files = slskdClient.flattenSearchResults(
    await slskdClient.waitForSearch("final-partials", 60000),
  );
  assert.deepEqual(files.map((file) => file.file).sort(), [
    "First.flac",
    "Second.flac",
    "Third.flac",
  ]);
});

test("a search waiting in slskd's queue gets its full windows once it runs", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  vi.spyOn(slskdClient, "deleteSearch").mockImplementation(async () => true);
  const runsAt = 1000 + 25000;
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => {
    if (Date.now() < runsAt) return { state: "Queued", responses: [] };
    if (Date.now() < runsAt + 4000) return { state: "InProgress", responses: [] };
    return {
      state: "Completed",
      fileCount: 1,
      responses: [{ username: "peer", files: [{ filename: "Song.flac" }] }],
    };
  });
  const pending = slskdClient.waitForSearch("queued-search", 10000);
  for (let step = 0; step < 40; step += 1) {
    await new Promise(setImmediate);
    vi.advanceTimersByTime(1000);
  }
  const result = slskdClient.flattenSearchResults(await pending);
  assert.deepEqual(
    result.map((file) => file.file),
    ["Song.flac"],
  );
});

test("a search still queued in slskd at the caller's deadline reports slskd as busy, not as no results", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  vi.spyOn(slskdClient, "createSearch").mockImplementation(async () => ({ id: "busy-search" }));
  const deleted = vi.spyOn(slskdClient, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(slskdClient, "getSearch").mockImplementation(async () => ({
    state: "Queued",
    responses: [],
  }));
  const pending = slskdClient.searchQuery("Artist Busy", { timeoutMs: 10000 });
  const outcome = assert.rejects(pending, /busy/i);
  for (let step = 0; step < 12; step += 1) {
    await new Promise(setImmediate);
    vi.advanceTimersByTime(1000);
  }
  await outcome;
  assert.deepEqual(
    deleted.mock.calls.map((call) => call[0]),
    ["busy-search"],
  );
});
