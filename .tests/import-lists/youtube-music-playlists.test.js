import test from "node:test";
import assert from "node:assert/strict";
import {
  YoutubeMusicPlaylistClient,
  extractYoutubePlaylistId,
  validateYoutubePlaylistId,
} from "../../backend/services/importLists/youtubeMusicPlaylists.js";

const text = (value) => ({ toString: () => value });

const song = ({ id, title, artist, album = null, seconds = null }) => ({
  item_type: "song",
  id,
  title: text(title),
  artists: artist ? [{ name: artist }] : [],
  album: album ? { name: album } : null,
  duration: seconds == null ? null : { seconds },
});

const video = ({ id, title, author, seconds = null }) => ({
  item_type: "video",
  id,
  title: text(title),
  authors: author ? [{ name: author }] : [],
  duration: seconds == null ? null : { seconds },
});

const continuation = (token) => ({
  type: "ContinuationItem",
  endpoint: { payload: { continuation: token } },
});

function makeClient(pages, options = {}) {
  let createCalls = 0;
  const ids = [];
  const factory = async () => {
    createCalls += 1;
    return {
      music: {
        async getPlaylist(id) {
          ids.push(id);
          return pages[0];
        },
      },
    };
  };
  const client = new YoutubeMusicPlaylistClient({
    createInnertube: factory,
    requestTimeoutMs: 100,
    operationTimeoutMs: 1_000,
    ...options,
  });
  return { client, ids, getCreateCalls: () => createCalls };
}

test("extractYoutubePlaylistId accepts only approved HTTPS playlist URLs", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]) {
    assert.equal(
      extractYoutubePlaylistId(`https://${host}/playlist?list=PLabcdefghij_123`),
      "PLabcdefghij_123",
    );
  }
  for (const value of [
    "http://music.youtube.com/playlist?list=PLabcdefghij_123",
    "https://evil.example/playlist?list=PLabcdefghij_123",
    "https://music.youtube.com/playlist",
    "https://music.youtube.com/playlist?list=short",
    "https://music.youtube.com/playlist?list=PLabcdefghij_123&list=PLabcdefghij_456",
    "not a url",
  ]) {
    assert.throws(() => extractYoutubePlaylistId(value), { statusCode: 400 });
  }
});

test("validateYoutubePlaylistId accepts raw IDs but not URLs or malformed values", () => {
  assert.equal(validateYoutubePlaylistId("PLabcdefghij_123"), "PLabcdefghij_123");
  assert.throws(() => validateYoutubePlaylistId("https://youtube.com/playlist?list=PLabcdefghij_123"), {
    statusCode: 400,
  });
  assert.throws(() => validateYoutubePlaylistId("bad/id"), { statusCode: 400 });
});

test("client follows continuations, normalizes songs and videos, and reuses one session", async () => {
  const second = {
    contents: [
      video({ id: "video-1", title: "Video Track", author: "Video Artist", seconds: 62 }),
      song({ id: "duplicate-id", title: "Song One", artist: "Artist One", album: "Album One" }),
      { item_type: "podcast_show", id: "podcast", title: text("Podcast") },
      song({ id: "incomplete", title: "No Artist" }),
      { item_type: "non_music_track", id: "non-music", title: text("Non-music") },
    ],
  };
  const first = {
    header: { title: text("Public playlist") },
    contents: [
      song({ id: "song-1", title: "Song One", artist: "Artist One", album: "Album One", seconds: 123 }),
      null,
      continuation("next-page"),
    ],
    async getContinuation() {
      return second;
    },
  };
  const { client, ids, getCreateCalls } = makeClient([first]);

  const result = await client.getPlaylist("PLabcdefghij_123");
  assert.deepEqual(ids, ["PLabcdefghij_123"]);
  assert.equal(getCreateCalls(), 1);
  assert.equal(result.id, "PLabcdefghij_123");
  assert.equal(result.name, "Public playlist");
  assert.deepEqual(result.tracks.map(({ artistName, trackName, albumName, durationMs }) => ({
    artistName,
    trackName,
    albumName,
    durationMs,
  })), [
    { artistName: "Artist One", trackName: "Song One", albumName: "Album One", durationMs: 123_000 },
    { artistName: "Video Artist", trackName: "Video Track", albumName: null, durationMs: 62_000 },
  ]);
  assert.deepEqual(result.stats, {
    sourceItems: 7,
    unavailable: 1,
    podcast: 2,
    incomplete: 1,
    duplicate: 1,
  });
  assert.deepEqual(result.excluded.map(({ position, reason }) => ({ position, reason })), [
    { position: 2, reason: "unavailable" },
    { position: 4, reason: "duplicate" },
    { position: 5, reason: "podcast" },
    { position: 6, reason: "incomplete" },
    { position: 7, reason: "podcast" },
  ]);

  await client.getPlaylist("PLabcdefghij_456");
  assert.equal(getCreateCalls(), 1);
});

test("client rejects repeated continuations instead of returning a partial playlist", async () => {
  const page = {
    header: { title: text("Loop") },
    contents: [song({ id: "song", title: "Song", artist: "Artist" }), continuation("same")],
  };
  page.getContinuation = async () => page;
  const { client } = makeClient([page]);
  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), { code: "YOUTUBE_PLAYLIST_INCOMPLETE" });
});

test("client rejects page and row limits without returning partial results", async () => {
  const next = { contents: [song({ id: "two", title: "Two", artist: "Artist" })] };
  const first = {
    header: { title: text("Limited") },
    contents: [song({ id: "one", title: "One", artist: "Artist" }), continuation("next")],
    async getContinuation() { return next; },
  };
  const pageLimited = makeClient([first], { maxPages: 1 }).client;
  await assert.rejects(pageLimited.getPlaylist("PLabcdefghij_123"), { code: "YOUTUBE_PLAYLIST_LIMIT" });

  const rowLimited = makeClient([{
    header: { title: text("Limited") },
    contents: [
      song({ id: "one", title: "One", artist: "Artist" }),
      song({ id: "two", title: "Two", artist: "Artist" }),
    ],
  }], { maxItems: 1 }).client;
  await assert.rejects(rowLimited.getPlaylist("PLabcdefghij_123"), { code: "YOUTUBE_PLAYLIST_LIMIT" });
});

test("client aborts and maps operation timeouts to a safe provider error", async () => {
  let observedSignal;
  const client = new YoutubeMusicPlaylistClient({
    operationTimeoutMs: 20,
    requestTimeoutMs: 100,
    createInnertube: async ({ fetch }) => ({
      music: {
        async getPlaylist() {
          await fetch("https://music.youtube.com/youtubei/v1/browse");
        },
      },
    }),
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_TIMEOUT",
    statusCode: 504,
  });
  assert.equal(observedSignal.aborted, true);
});

test("client times out stalled session creation and retries with a fresh session", { timeout: 1_000 }, async () => {
  let createCalls = 0;
  const client = new YoutubeMusicPlaylistClient({
    operationTimeoutMs: 20,
    createInnertube: async () => {
      createCalls += 1;
      if (createCalls === 1) return new Promise(() => {});
      return {
        music: {
          async getPlaylist() {
            return {
              header: { title: text("Recovered playlist") },
              contents: [song({ id: "song", title: "Song", artist: "Artist" })],
            };
          },
        },
      };
    },
  });

  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_TIMEOUT",
    statusCode: 504,
  });
  const recovered = await client.getPlaylist("PLabcdefghij_123");

  assert.equal(createCalls, 2);
  assert.equal(recovered.name, "Recovered playlist");
});
