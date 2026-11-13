import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { deemixSource }, settings] = await setupIsolatedBackend(
  "deemix-queue-poll",
  () => import("../../backend/services/deemixSource.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => cleanupIsolatedState(isolatedState));

const directory = "/nonexistent/aurral-deemix-handover";

const client = settings.getDownloadClient("deemix");
const queue = (items: Awaited<ReturnType<typeof client.getQueue>>) =>
  vi.spyOn(client, "getQueue").mockImplementation(async () => items);

test("a track deemix no longer lists moves on instead of waiting out the polling limit", async () => {
  queue({});
  await assert.rejects(
    deemixSource.status({ id: "track_1_1", directory }),
    /deemix no longer lists this download in its queue/,
  );
});

test("a track deemix is still downloading keeps waiting", async () => {
  queue({ track_1_1: { status: "downloading" } });
  assert.deepEqual(await deemixSource.status({ id: "track_1_1", directory }), { done: false });
});
