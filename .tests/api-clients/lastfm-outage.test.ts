import assert from "node:assert/strict";
import { afterAll, test, vi } from "vite-plus/test";
import type { LogEntry } from "../../backend/services/logger.ts";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { default: axios }, { lastfmRequest }, { startLogSink }] = await setupIsolatedBackend(
  "lastfm-outage",
  () => import("../../lib/axiosFetch.ts"),
  () => import("../../backend/services/apiClients/lastfm.ts"),
  () => import("../../backend/services/logger.ts"),
);

afterAll(() => cleanupIsolatedState(state));

test("Last.fm pauses for a minute after three requests in a row get no answer", async (t: import("vite-plus/test").TestContext) => {
  process.env.LASTFM_API_KEY = "test-key";
  const logged: LogEntry[] = [];
  startLogSink((entry) => logged.push(entry));
  const get = vi
    .spyOn(axios, "get")
    .mockRejectedValue(
      Object.assign(new Error("timeout of 3000ms exceeded"), { code: "ECONNABORTED" }),
    );
  t.onTestFinished(() => {
    get.mockRestore();
    delete process.env.LASTFM_API_KEY;
  });
  const ask = (artist: string) => lastfmRequest("artist.getSimilar", { artist }, { maxRetries: 0 });

  for (const artist of ["a", "b", "c", "d"]) assert.equal(await ask(artist), null);
  assert.equal(get.mock.calls.length, 3);
  assert.deepEqual(
    logged.filter((entry) => entry.cat === "api").map((entry) => [entry.level, entry.msg]),
    [
      ["warn", "Last.fm API timeout (artist.getSimilar)"],
      ["warn", "Last.fm is not responding, pausing requests for a minute"],
    ],
  );

  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  get.mockResolvedValueOnce({
    status: 200,
    statusText: "OK",
    headers: {},
    data: { similarartists: { artist: [] } },
  });
  assert.deepEqual(await ask("e"), { similarartists: { artist: [] } });
});
