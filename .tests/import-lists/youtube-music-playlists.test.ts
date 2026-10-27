type ClientOptions = NonNullable<ConstructorParameters<typeof YoutubeMusicPlaylistClient>[0]>;
type SessionFactory = NonNullable<ClientOptions["createInnertube"]>;
type PlaylistPage = {
  header?: {
    title: ReturnType<typeof text>;
    thumbnails?: { url: string; width: number }[];
    thumbnail?: { contents: { url: string; width: number }[] };
  };
  contents: unknown[];
  getContinuation?: () => Promise<PlaylistPage>;
};
import { afterEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  YoutubeMusicPlaylistClient,
  extractYoutubePlaylistId,
  validateYoutubePlaylistId,
} from "../../backend/services/importLists/youtubeMusicPlaylists.ts";

const text = (value: string) => ({ toString: () => value });

const useFakeClock = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
afterEach(() => {
  vi.useRealTimers();
});

const song = ({
  id,
  title,
  artist,
  album = null,
  seconds = null,
}: {
  id: string;
  title: string;
  artist?: string;
  album?: string | null;
  seconds?: number | null;
}) => ({
  item_type: "song",
  id,
  title: text(title),
  artists: artist ? [{ name: artist }] : [],
  album: album ? { name: album } : null,
  duration: seconds == null ? null : { seconds },
});

const video = ({
  id,
  title,
  author,
  seconds = null,
}: {
  id: string;
  title: string;
  author: string;
  seconds?: number | null;
}) => ({
  item_type: "video",
  id,
  title: text(title),
  authors: author ? [{ name: author }] : [],
  duration: seconds == null ? null : { seconds },
});

const continuation = (token: string) => ({
  type: "ContinuationItem",
  endpoint: { payload: { continuation: token } },
});

function makeClient(
  pages: PlaylistPage[],
  options: Pick<ClientOptions, "maxPages" | "maxItems"> = {},
) {
  let createCalls = 0;
  const ids: string[] = [];
  const factory = async () => {
    createCalls += 1;
    return {
      music: {
        async getPlaylist(id: string) {
          ids.push(id);
          return pages[0];
        },
      },
    };
  };
  const client = new YoutubeMusicPlaylistClient({
    createInnertube: factory as unknown as SessionFactory,
    requestTimeoutMs: 100,
    operationTimeoutMs: 1_000,
    playlistRequestIntervalMs: 0,
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
  assert.throws(
    () => validateYoutubePlaylistId("https://youtube.com/playlist?list=PLabcdefghij_123"),
    {
      statusCode: 400,
    },
  );
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
    header: {
      title: text("Public playlist"),
      thumbnail: {
        contents: [
          { url: "https://images.example.test/small.jpg", width: 120 },
          { url: "https://images.example.test/large.jpg", width: 1000 },
        ],
      },
    },
    contents: [
      song({
        id: "song-1",
        title: "Song One",
        artist: "Artist One",
        album: "Album One",
        seconds: 123,
      }),
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
  assert.equal(result.artworkUrl, "https://images.example.test/large.jpg");
  assert.deepEqual(
    result.tracks.map(({ artistName, trackName, albumName, durationMs }) => ({
      artistName,
      trackName,
      albumName,
      durationMs,
    })),
    [
      {
        artistName: "Artist One",
        trackName: "Song One",
        albumName: "Album One",
        durationMs: 123_000,
      },
      { artistName: "Video Artist", trackName: "Video Track", albumName: null, durationMs: 62_000 },
    ],
  );
  assert.deepEqual(result.stats, {
    sourceItems: 7,
    unavailable: 1,
    podcast: 2,
    incomplete: 1,
    duplicate: 1,
  });
  assert.deepEqual(
    result.excluded.map(({ position, reason }) => ({ position, reason })),
    [
      { position: 2, reason: "unavailable" },
      { position: 4, reason: "duplicate" },
      { position: 5, reason: "podcast" },
      { position: 6, reason: "incomplete" },
      { position: 7, reason: "podcast" },
    ],
  );

  await client.getPlaylist("PLabcdefghij_456");
  assert.equal(getCreateCalls(), 1);
});

test("client reuses a recently loaded playlist instead of refetching every continuation", async () => {
  let playlistRequests = 0;
  let continuationRequests = 0;
  const second = {
    contents: [song({ id: "two", title: "Two", artist: "Artist" })],
  };
  const first = {
    header: { title: text("Large playlist") },
    contents: [song({ id: "one", title: "One", artist: "Artist" }), continuation("next")],
    async getContinuation() {
      continuationRequests += 1;
      return second;
    },
  };
  const client = new YoutubeMusicPlaylistClient({
    playlistRequestIntervalMs: 0,
    createInnertube: (async () => ({
      music: {
        async getPlaylist() {
          playlistRequests += 1;
          return first;
        },
      },
    })) as unknown as SessionFactory,
  });

  const [firstResult, concurrentResult] = await Promise.all([
    client.getPlaylist("PLabcdefghij_123"),
    client.getPlaylist("PLabcdefghij_123"),
  ]);
  const importResult = await client.getPlaylist("PLabcdefghij_123");

  assert.deepEqual(concurrentResult, firstResult);
  assert.deepEqual(importResult, firstResult);
  assert.equal(playlistRequests, 1);
  assert.equal(continuationRequests, 1);
});

test("client bypasses a cached playlist when a fresh provider read is required", async () => {
  let playlistRequests = 0;
  const client = new YoutubeMusicPlaylistClient({
    playlistRequestIntervalMs: 0,
    createInnertube: (async () => ({
      music: {
        async getPlaylist() {
          playlistRequests += 1;
          return {
            header: { title: text(`Playlist ${playlistRequests}`) },
            contents: [song({ id: "one", title: "One", artist: "Artist" })],
          };
        },
      },
    })) as unknown as SessionFactory,
  });

  const first = await client.getPlaylist("PLabcdefghij_123");
  const cached = await client.getPlaylist("PLabcdefghij_123");
  const refreshed = await client.getPlaylist("PLabcdefghij_123", { forceRefresh: true });

  assert.equal(first.name, "Playlist 1");
  assert.equal(cached.name, "Playlist 1");
  assert.equal(refreshed.name, "Playlist 2");
  assert.equal(playlistRequests, 2);
});

test("client force refresh bypasses an in-flight playlist load", async () => {
  const resolvers: ((value: PlaylistPage | PromiseLike<PlaylistPage>) => void)[] = [];
  let playlistRequests = 0;
  const client = new YoutubeMusicPlaylistClient({
    playlistRequestIntervalMs: 0,
    createInnertube: (async () => ({
      music: {
        async getPlaylist() {
          playlistRequests += 1;
          return new Promise<PlaylistPage>((resolve) => resolvers.push(resolve));
        },
      },
    })) as unknown as SessionFactory,
  });

  const preview = client.getPlaylist("PLabcdefghij_123");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const refreshed = client.getPlaylist("PLabcdefghij_123", { forceRefresh: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(playlistRequests, 2);
  resolvers[0]({ header: { title: text("Preview") }, contents: [] });
  resolvers[1]({ header: { title: text("Fresh") }, contents: [] });
  assert.equal((await preview).name, "Preview");
  assert.equal((await refreshed).name, "Fresh");
});

test("client spaces provider requests shared by concurrent playlist loads", async () => {
  useFakeClock();
  const starts: { id: string; at: number }[] = [];
  const client = new YoutubeMusicPlaylistClient({
    playlistRequestIntervalMs: 30,
    createInnertube: (async () => ({
      music: {
        async getPlaylist(id: string) {
          starts.push({ id, at: Date.now() });
          return {
            header: { title: text(id) },
            contents: [song({ id: `song-${id}`, title: id, artist: "Artist" })],
          };
        },
      },
    })) as unknown as SessionFactory,
  });

  const loads = Promise.all([
    client.getPlaylist("PLabcdefghij_123"),
    client.getPlaylist("PLabcdefghij_456"),
  ]);
  await vi.advanceTimersByTimeAsync(30);
  await loads;

  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 20);
});

test(
  "queued playlist requests keep their own operation timeout context",
  { timeout: 1_000 },
  async () => {
    const client = new YoutubeMusicPlaylistClient({
      operationTimeoutMs: 200,
      playlistRequestIntervalMs: 50,
      createInnertube: (async ({ fetch }: Parameters<SessionFactory>[0]) => ({
        music: {
          async getPlaylist(id: string) {
            if (id === "PLabcdefghij_000") {
              return {
                header: { title: text("Warmup") },
                contents: [song({ id: "warmup", title: "Warmup", artist: "Artist" })],
              };
            }
            assert.ok(fetch);
            await fetch(`https://music.youtube.com/youtubei/v1/browse?id=${id}`);
          },
        },
      })) as unknown as SessionFactory,
      fetchImpl: async (_url, options) =>
        new Promise<Response>((resolve, reject) => {
          assert.ok(options != null);
          assert.ok(options.signal != null);
          options.signal.addEventListener("abort", () => reject(options?.signal?.reason), {
            once: true,
          });
        }),
    });

    useFakeClock();
    await client.getPlaylist("PLabcdefghij_000");
    const first = assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
      code: "YOUTUBE_PLAYLIST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(10);
    const second = assert.rejects(client.getPlaylist("PLabcdefghij_456"), {
      code: "YOUTUBE_PLAYLIST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(210);

    await first;
    await second;
  },
);

test("cache keeps pending playlist loads available for request coalescing", async () => {
  let releaseRequests!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  const requests = new Map();
  const client = new YoutubeMusicPlaylistClient({
    maxCachedPlaylists: 1,
    playlistRequestIntervalMs: 0,
    createInnertube: (async () => ({
      music: {
        async getPlaylist(id: string) {
          requests.set(id, (requests.get(id) || 0) + 1);
          await released;
          return {
            header: { title: text(id) },
            contents: [song({ id: `song-${id}`, title: id, artist: "Artist" })],
          };
        },
      },
    })) as unknown as SessionFactory,
  });

  const first = client.getPlaylist("PLabcdefghij_123");
  const second = client.getPlaylist("PLabcdefghij_456");
  const repeatedFirst = client.getPlaylist("PLabcdefghij_123");
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseRequests();
  await Promise.all([first, second, repeatedFirst]);

  assert.equal(requests.get("PLabcdefghij_123"), 1);
  assert.equal(requests.get("PLabcdefghij_456"), 1);
});

test("client opens a local cooldown when YouTube Music returns a rate limit", async () => {
  let requests = 0;
  const client = new YoutubeMusicPlaylistClient({
    playlistRequestIntervalMs: 0,
    createInnertube: (async ({ fetch }: Parameters<SessionFactory>[0]) => ({
      music: {
        async getPlaylist() {
          await fetch?.("https://music.youtube.com/youtubei/v1/browse");
        },
      },
    })) as unknown as SessionFactory,
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "60" },
      });
    },
  });

  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_RATE_LIMITED",
    statusCode: 429,
  });
  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_RATE_LIMITED",
    statusCode: 429,
  });
  assert.equal(requests, 1);
});

test("client keeps the longest cooldown from overlapping rate limits", async () => {
  const responses: ((value: Response | PromiseLike<Response>) => void)[] = [];
  let requests = 0;
  const client = new YoutubeMusicPlaylistClient({
    fetchImpl: async () => {
      requests += 1;
      if (requests > 2) return new Response(null, { status: 200 });
      return new Promise<Response>((resolve) => responses.push(resolve));
    },
  });

  const longer = client.fetch("https://music.youtube.com/youtubei/v1/browse");
  const shorter = client.fetch("https://music.youtube.com/youtubei/v1/browse");
  responses[0](new Response(null, { status: 429, headers: { "retry-after": "120" } }));
  await assert.rejects(longer, { code: "YOUTUBE_PLAYLIST_RATE_LIMITED" });
  responses[1](new Response(null, { status: 429, headers: { "retry-after": "0" } }));
  await assert.rejects(shorter, { code: "YOUTUBE_PLAYLIST_RATE_LIMITED" });

  await assert.rejects(client.fetch("https://music.youtube.com/youtubei/v1/browse"), {
    code: "YOUTUBE_PLAYLIST_RATE_LIMITED",
  });
  assert.equal(requests, 2);
});

test("client rejects repeated continuations instead of returning a partial playlist", async () => {
  const page: PlaylistPage = {
    header: { title: text("Loop") },
    contents: [song({ id: "song", title: "Song", artist: "Artist" }), continuation("same")],
  };
  page.getContinuation = async () => page;
  const { client } = makeClient([page]);
  await assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_INCOMPLETE",
  });
});

test("client rejects page and row limits without returning partial results", async () => {
  const next = { contents: [song({ id: "two", title: "Two", artist: "Artist" })] };
  const first = {
    header: { title: text("Limited") },
    contents: [song({ id: "one", title: "One", artist: "Artist" }), continuation("next")],
    async getContinuation() {
      return next;
    },
  };
  const pageLimited = makeClient([first], { maxPages: 1 }).client;
  await assert.rejects(pageLimited.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_LIMIT",
  });

  const rowLimited = makeClient(
    [
      {
        header: { title: text("Limited") },
        contents: [
          song({ id: "one", title: "One", artist: "Artist" }),
          song({ id: "two", title: "Two", artist: "Artist" }),
        ],
      },
    ],
    { maxItems: 1 },
  ).client;
  await assert.rejects(rowLimited.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_LIMIT",
  });
});

test("client aborts and maps operation timeouts to a safe provider error", async () => {
  useFakeClock();
  let observedSignal: AbortSignal | null | undefined;
  const client = new YoutubeMusicPlaylistClient({
    operationTimeoutMs: 20,
    requestTimeoutMs: 100,
    createInnertube: (async ({ fetch }: Parameters<SessionFactory>[0]) => ({
      music: {
        async getPlaylist() {
          await fetch?.("https://music.youtube.com/youtubei/v1/browse");
        },
      },
    })) as unknown as SessionFactory,
    fetchImpl: async (_url, options) => {
      assert.ok(options != null);
      observedSignal = options.signal;
      return new Promise<Response>((resolve, reject) => {
        assert.ok(options != null);
        assert.ok(options.signal != null);
        options.signal.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        });
      });
    },
  });
  const timedOut = assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
    code: "YOUTUBE_PLAYLIST_TIMEOUT",
    statusCode: 504,
  });
  await vi.advanceTimersByTimeAsync(20);
  await timedOut;
  assert.ok(observedSignal != null);
  assert.equal(observedSignal.aborted, true);
});

test(
  "client times out stalled session creation and retries with a fresh session",
  { timeout: 1_000 },
  async () => {
    useFakeClock();
    let createCalls = 0;
    const client = new YoutubeMusicPlaylistClient({
      operationTimeoutMs: 20,
      createInnertube: (async () => {
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
      }) as unknown as SessionFactory,
    });

    const timedOut = assert.rejects(client.getPlaylist("PLabcdefghij_123"), {
      code: "YOUTUBE_PLAYLIST_TIMEOUT",
      statusCode: 504,
    });
    await vi.advanceTimersByTimeAsync(20);
    await timedOut;
    const recovered = await client.getPlaylist("PLabcdefghij_123");

    assert.equal(createCalls, 2);
    assert.equal(recovered.name, "Recovered playlist");
  },
);

test("legacy YouTube playlist headers retain their thumbnail", async () => {
  const { client } = makeClient([
    {
      header: {
        title: text("Legacy playlist"),
        thumbnails: [{ url: "https://images.example.test/original.jpg", width: 800 }],
      },
      contents: [],
    },
  ]);
  assert.equal(
    (await client.getPlaylist("PLabcdefghij_123")).artworkUrl,
    "https://images.example.test/original.jpg",
  );
});
