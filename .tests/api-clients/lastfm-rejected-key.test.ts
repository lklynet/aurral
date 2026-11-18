import assert from "node:assert/strict";
import { afterAll, afterEach, test, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { http, HttpError }, { lastfmRequest }, { getMusicDataSourceName }] =
  await setupIsolatedBackend(
    "lastfm-rejected-key",
    () => import("../../lib/http.ts"),
    () => import("../../backend/services/apiClients/lastfm.ts"),
    () => import("../../backend/services/musicDataSource/index.ts"),
  );

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LASTFM_API_KEY;
});

afterAll(() => cleanupIsolatedState(state));

const refuse = (error: number) =>
  new HttpError(
    "Request to ws.audioscrobbler.com failed with status code 403",
    { method: "GET", url: "https://ws.audioscrobbler.com/2.0/" },
    { response: { status: 403, statusText: "Forbidden", headers: {}, data: { error } } },
  );

const ask = (artist: string) => lastfmRequest("artist.getSimilar", { artist }, { maxRetries: 0 });

test("discovery leaves Last.fm while it rejects the key and returns once it answers", async () => {
  process.env.LASTFM_API_KEY = "expired-key";
  const get = vi.spyOn(http, "get").mockRejectedValueOnce(refuse(17));
  assert.equal(await ask("private"), null);
  assert.equal(getMusicDataSourceName(), "lastfm");

  get.mockRejectedValueOnce(refuse(10));
  assert.equal(await ask("rejected"), null);
  assert.equal(getMusicDataSourceName(), "listenbrainz");

  process.env.LASTFM_API_KEY = "new-key";
  assert.equal(getMusicDataSourceName(), "lastfm");

  process.env.LASTFM_API_KEY = "expired-key";
  get.mockResolvedValueOnce({
    status: 200,
    statusText: "OK",
    headers: {},
    data: { similarartists: { artist: [] } },
  });
  assert.deepEqual(await ask("accepted"), { similarartists: { artist: [] } });
  assert.equal(getMusicDataSourceName(), "lastfm");
});
