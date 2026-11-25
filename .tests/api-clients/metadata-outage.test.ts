import assert from "node:assert/strict";
import * as v from "valibot";
import { afterAll, onTestFinished, test, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  state,
  { http, HttpError },
  { musicbrainzGet },
  { listenbrainzRequest },
  { deezerGetRelatedArtists },
  { clearApiCaches },
  { getArtistByMbid },
] = await setupIsolatedBackend(
  "metadata-outage",
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/apiClients/musicbrainzHttp.ts"),
  () => import("../../backend/services/apiClients/listenbrainz.ts"),
  () => import("../../backend/services/apiClients/deezer.ts"),
  () => import("../../backend/services/apiClients/clearCache.ts"),
  () => import("../../backend/services/providers/metadataProvider.ts"),
);

afterAll(() => cleanupIsolatedState(state));

const refused = (service: string) =>
  new HttpError(
    "fetch failed",
    { method: "GET", url: `https://${service}.invalid/` },
    { code: "ECONNREFUSED" },
  );

const outcome = (request: Promise<unknown>) =>
  request.then(
    () => null,
    (error: unknown) => (error instanceof HttpError ? error.code : error),
  );

test.each([
  ["MusicBrainz", (n: number) => musicbrainzGet(v.unknown(), `/artist/${n}`, {})],
  ["ListenBrainz", (n: number) => listenbrainzRequest("/1/stats/sitewide/artists", { count: n })],
  ["Deezer", (n: number) => deezerGetRelatedArtists(n)],
])(
  "%s pauses queued requests for a minute after three in a row get no answer",
  async (service, ask) => {
    clearApiCaches();
    const get = vi.spyOn(http, "get").mockRejectedValue(refused(service));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    onTestFinished(() => {
      get.mockRestore();
      vi.useRealTimers();
      clearApiCaches();
    });

    const queued = Promise.all([1, 2, 3, 4].map((n) => outcome(ask(n))));
    await vi.runAllTimersAsync();
    assert.deepEqual(await queued, ["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED", "PAUSED"]);
    assert.equal(get.mock.calls.length, 3);

    let whilePaused: unknown = "waiting";
    void outcome(ask(5)).then((code) => (whilePaused = code));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(whilePaused, "PAUSED");

    vi.advanceTimersByTime(61_000);
    const resumed = outcome(ask(6));
    await vi.runAllTimersAsync();
    assert.equal(await resumed, "ECONNREFUSED");
    assert.equal(get.mock.calls.length, 4);
  },
);

test("an answer during ListenBrainz retries resets the count toward a pause", async () => {
  clearApiCaches();
  const busy = new HttpError(
    "Request failed with status code 503",
    { method: "GET", url: "https://api.listenbrainz.org/" },
    { response: { status: 503, statusText: "", headers: {}, data: null } },
  );
  const get = vi
    .spyOn(http, "get")
    .mockRejectedValueOnce(refused("ListenBrainz"))
    .mockRejectedValueOnce(refused("ListenBrainz"))
    .mockRejectedValueOnce(busy)
    .mockRejectedValue(refused("ListenBrainz"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  onTestFinished(() => {
    get.mockRestore();
    vi.useRealTimers();
    clearApiCaches();
  });
  const ask = async (count: number) => {
    const answer = outcome(listenbrainzRequest("/1/stats/sitewide/artists", { count }));
    await vi.runAllTimersAsync();
    return answer;
  };

  assert.equal(await ask(1), "ECONNREFUSED");
  assert.equal(await ask(2), "ECONNREFUSED");
  assert.equal(await ask(3), "ECONNREFUSED");
  assert.equal(get.mock.calls.length, 4);
  assert.equal(await ask(4), "ECONNREFUSED");
  assert.equal(get.mock.calls.length, 5);
});

test("AurralBrainz pauses for a minute after three requests in a row get no answer", async () => {
  clearApiCaches();
  const get = vi.spyOn(http, "get").mockRejectedValue(refused("data.aurral.org"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  onTestFinished(() => {
    get.mockRestore();
    vi.useRealTimers();
    clearApiCaches();
  });
  const ask = async (n: number) => {
    const answer = outcome(getArtistByMbid(`artist-${n}`));
    await vi.runAllTimersAsync();
    return answer;
  };

  assert.deepEqual(
    [await ask(1), await ask(2), await ask(3), await ask(4)],
    ["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED", "PAUSED"],
  );
  assert.equal(get.mock.calls.length, 3);

  vi.advanceTimersByTime(61_000);
  assert.equal(await ask(5), "ECONNREFUSED");
  assert.equal(get.mock.calls.length, 4);
});
