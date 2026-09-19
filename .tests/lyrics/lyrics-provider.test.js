import assert from "node:assert/strict";
import test from "node:test";
import { dbOps } from "../../backend/db/helpers/index.js";
import { assertLyricsProvider } from "../../backend/services/lyrics/lyricsProvider.js";
import {
  findLyrics,
  getLyricsProviderSettings,
  getLyricsProviders,
} from "../../backend/services/lyrics/lyricsProviders.js";
import {
  LrclibClient,
  bestMatch,
  describeError,
  lyricsCacheKey,
  retryDelayMs,
} from "../../backend/services/lrclibClient.js";
import { registerLyrics } from "../../backend/routes/settings/handlers/lyrics.js";
import { durationSeconds } from "../../backend/routes/lyrics.js";

test("lyrics providers must implement the full adapter contract", () => {
  assert.throws(
    () =>
      assertLyricsProvider({
        key: "stub",
        name: "Stub",
        isConfigured() {},
        testConnection() {},
        getStatus() {},
        updateConfig() {},
        getPriority() {},
      }),
    /LyricsProvider\.getLyrics must be a function/,
  );
  assert.throws(
    () => assertLyricsProvider({ key: "", name: "Stub" }),
    /LyricsProvider\.key must be a non-empty string/,
  );
});

test("lyrics adapters expose settings metadata without field values", () => {
  const settings = getLyricsProviderSettings();

  assert.deepEqual(Object.keys(settings), ["lrclib"]);
  assert.deepEqual(settings.lrclib.validation.required, []);
  assert.equal(settings.lrclib.fields.find((field) => field.key === "url").type, "url");
  for (const definition of Object.values(settings)) {
    for (const field of definition.fields) {
      assert.equal("value" in field, false);
      assert.equal("default" in field, false);
    }
  }
});

test("LRCLIB needs no credentials but stays off until it is enabled", () => {
  const client = new LrclibClient({ enabled: false });

  assert.equal(client.isConfigured(), false);
  client.updateConfig({ enabled: true });
  assert.equal(client.isConfigured(), true);
  assert.equal(client.getStatus().url, "https://lrclib.net");
  assert.equal(client.getPriority(), 10);
  client.updateConfig({ enabled: true, url: "http://lrclib.local/", priority: 3 });
  assert.equal(client.getStatus().url, "http://lrclib.local");
  assert.equal(client.getPriority(), 3);
});

test("a synced result outranks a plain one", () => {
  assert.equal(bestMatch([]), null);
  assert.equal(bestMatch([{ id: 1, plainLyrics: "", syncedLyrics: "" }]), null);
  assert.equal(
    bestMatch([
      { id: 1, trackName: "Plain", plainLyrics: "words" },
      { id: 2, trackName: "Synced", plainLyrics: "words", syncedLyrics: "[00:01.00] words" },
    ]).id,
    2,
  );
  assert.equal(
    bestMatch([{ id: 3, trackName: "Only plain", plainLyrics: "words" }]).id,
    3,
  );
  assert.equal(bestMatch([{ id: 4, trackName: "Instrumental", instrumental: true }]).id, 4);
});

test("a busy LRCLIB is retried once for as long as it asks", () => {
  const busy = (headers) => ({ response: { status: 503, headers } });

  assert.equal(retryDelayMs(busy({ "retry-after": "1" })), 1000);
  assert.equal(retryDelayMs(busy({ "retry-after": "3" })), 3000);
  // A server asking for a long wait must not hold the request open that long.
  assert.equal(retryDelayMs(busy({ "retry-after": "600" })), 5000);
  assert.equal(retryDelayMs(busy({ "retry-after": "soon" })), 1000);
  assert.equal(retryDelayMs(busy({})), 1000);
  assert.equal(retryDelayMs({ response: { status: 404 } }), null);
  assert.equal(retryDelayMs(new Error("socket hang up")), null);
});

test("LRCLIB's own explanation beats the status code", () => {
  assert.equal(
    describeError({ response: { data: { message: "The server is busy, please retry in a moment" } } })
      .message,
    "LRCLIB: The server is busy, please retry in a moment",
  );
  const network = new Error("socket hang up");
  assert.equal(describeError(network), network);
});

test("the same track is only asked for once, per instance", () => {
  const track = { artist: "Radiohead", title: "Creep", album: "Pablo Honey", durationSec: 238 };

  // Casing and padding are how the same track arrives from different callers.
  assert.equal(
    lyricsCacheKey("https://lrclib.net", track),
    lyricsCacheKey("https://lrclib.net/", {
      artist: " radiohead ",
      title: "CREEP",
      album: "pablo honey",
      durationSec: "238",
    }),
  );
  // A different instance may hold different lyrics, so it cannot reuse the answer.
  assert.notEqual(
    lyricsCacheKey("https://lrclib.net", track),
    lyricsCacheKey("http://lrclib.local", track),
  );
  // Duration and album are part of what LRCLIB matches on.
  assert.notEqual(
    lyricsCacheKey("https://lrclib.net", track),
    lyricsCacheKey("https://lrclib.net", { ...track, durationSec: 241 }),
  );
  assert.notEqual(
    lyricsCacheKey("https://lrclib.net", track),
    lyricsCacheKey("https://lrclib.net", { ...track, album: "OK Computer" }),
  );
});

test("only enabled providers take part in a lookup", async () => {
  dbOps.updateSettings({ integrations: { lrclib: { enabled: false } } });
  assert.deepEqual(getLyricsProviders(), []);
  assert.equal(await findLyrics({ artist: "Radiohead", title: "Creep" }), null);

  dbOps.updateSettings({ integrations: { lrclib: { enabled: true, priority: 5 } } });
  const providers = getLyricsProviders();
  assert.deepEqual(
    providers.map((provider) => provider.key),
    ["lrclib"],
  );
  assert.equal(providers[0].getPriority(), 5);

  dbOps.updateSettings({ integrations: {} });
});

test("a lyrics provider test rejects a blocked server URL", async () => {
  const routes = [];
  const router = {
    get(path, handler) {
      routes.push({ method: "GET", path, handler });
    },
    post(path, handler) {
      routes.push({ method: "POST", path, handler });
    },
  };
  registerLyrics(router);
  const route = routes.find(
    ({ method, path }) => method === "POST" && path === "/lyrics/:key/test",
  );
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await route.handler(
    { params: { key: "lrclib" }, body: { enabled: true, url: "http://169.254.169.254" } },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: "Connection failed",
    message: "Server URL: Target host is blocked",
  });
});

test("an unusable duration is ignored rather than narrowing the search", () => {
  assert.equal(durationSeconds("238"), 238);
  assert.equal(durationSeconds(" 238 "), 238);

  // Express hands a repeated query parameter over as an array, which parseInt
  // would quietly read as its first entry.
  assert.equal(durationSeconds(["180", "240"]), 0);
  assert.equal(durationSeconds("180ms"), 0);
  assert.equal(durationSeconds("-5"), 0);
  assert.equal(durationSeconds("1.5"), 0);
  assert.equal(durationSeconds(""), 0);
  assert.equal(durationSeconds(undefined), 0);
  assert.equal(durationSeconds("0"), 0);

  // A track longer than a day is a typo, not a duration.
  assert.equal(durationSeconds("999999999"), 86400);
});
