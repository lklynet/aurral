import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

function silentWav(seconds, sampleRate = 8000) {
  const dataSize = seconds * sampleRate;
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const wav = silentWav(60);

const artist = {
  id: "1",
  identityKey: "artist:collection",
  mbid: null,
  name: "Collection Artist",
  albumIds: ["10", "20"],
  sources: ["aurral"],
};

const albumEntity = (id, title, releaseDate, trackIds) => ({
  id,
  identityKey: `album:${id}`,
  mbid: null,
  releaseGroupMbid: null,
  artistId: artist.id,
  title,
  albumArtist: artist.name,
  releaseDate,
  trackIds,
  trackCount: trackIds.length,
  availableTrackCount: trackIds.length,
  sources: ["aurral"],
});

const trackEntity = (id, title, albumId, trackNumber) => ({
  id,
  identityKey: `track:${id}`,
  mbid: null,
  title,
  artistName: artist.name,
  durationMs: 60_000,
  albums: [{ albumId, discNumber: 1, trackNumber }],
  files: [{ albumId, available: true, format: "wav", durationMs: 60_000, source: "aurral" }],
  sources: ["aurral"],
});

const laterAlbum = albumEntity("20", "Later Album", "2022-01-01", ["201", "202"]);
const earlierAlbum = albumEntity("10", "Earlier Album", "2019-01-01", ["101", "102"]);
const tracks = {
  morning: trackEntity("101", "Morning", "10", 1),
  noon: trackEntity("102", "Noon", "10", 2),
  gust: trackEntity("201", "Gust", "20", 1),
  calm: trackEntity("202", "Calm", "20", 2),
};

const page = (kind, items, { albums = [], artists = [artist], trackList = [], hasMore = false, number = 1 } = {}) => ({
  kind,
  page: number,
  pageSize: 100,
  total: items.length,
  hasMore,
  items,
  artists,
  albums,
  tracks: trackList,
  genres: [],
});

async function fixture(browserPage) {
  const created = [];
  await browserPage.routeWebSocket("**/ws**", (socket) => socket.close());
  await browserPage.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    const params = url.searchParams;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path.startsWith("/library/canonical-stream/")) {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers().range || "");
      const headers = { "content-type": "audio/wav", "accept-ranges": "bytes" };
      if (!match) return route.fulfill({ status: 200, headers, body: wav });
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : wav.length - 1;
      return route.fulfill({
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${wav.length}` },
        body: wav.subarray(start, end + 1),
      });
    }
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (path === "/health") return json({ lidarrConfigured: true });
    if (path === "/library/canonical") {
      const kind = params.get("kind");
      if (kind === "albums") {
        return json(page("albums", [earlierAlbum, laterAlbum], { albums: [earlierAlbum, laterAlbum] }));
      }
      if (kind === "artists") return json(page("artists", [artist]));
      if (kind === "tracks" && params.get("albumId") === earlierAlbum.id) {
        return json(page("tracks", [tracks.morning, tracks.noon], {
          albums: [earlierAlbum],
          trackList: [tracks.morning, tracks.noon],
        }));
      }
      if (kind === "tracks" && params.get("artistId") === artist.id) {
        const first = params.get("page") !== "2";
        const items = first ? [tracks.calm, tracks.gust] : [tracks.morning, tracks.noon];
        return json(page("tracks", items, {
          albums: first ? [laterAlbum] : [earlierAlbum],
          trackList: items,
          hasMore: first,
          number: first ? 1 : 2,
        }));
      }
    }
    if (path === "/playlists/status") return json({ sharedPlaylists: [], flows: [] });
    if (path === "/playlists/shared-playlists" && request.method() === "POST") {
      created.push(request.postDataJSON());
      return json({ success: true, playlistId: "created", queued: true });
    }
    if (path === "/library/favorites") return json({});
    if (path === "/settings") return json({});
    return json([]);
  });
  return created;
}

async function upNextTitles(region) {
  return region.locator(".player-queue__list .player-queue__name").allTextContents();
}

test("album and artist menus queue every Library track in album order", async ({ page: browserPage }) => {
  await fixture(browserPage);
  await browserPage.goto("/library/albums");

  await browserPage.getByRole("button", { name: "Earlier Album options" }).click();
  await browserPage.getByRole("menuitem", { name: "Add to queue" }).click();
  const bar = browserPage.locator(".global-player__inner");
  await expect(bar.locator(".global-player__title")).toHaveText("Morning");

  await browserPage.getByRole("link", { name: "Artists", exact: true }).first().click();
  await browserPage.getByRole("button", { name: "Collection Artist options" }).click();
  await browserPage.getByRole("menuitem", { name: "Play next" }).click();
  await expect(browserPage.getByText("Playing next")).toBeVisible();

  await bar.getByRole("button", { name: "Queue" }).click();
  const panel = browserPage.getByRole("complementary", { name: "Queue" });
  await expect.poll(() => upNextTitles(panel)).toEqual(["Morning", "Noon", "Gust", "Calm", "Noon"]);
  await expect(bar.locator(".global-player__title")).toHaveText("Morning");
});

test("adding an artist to a new playlist saves all of its Library tracks", async ({ page: browserPage }) => {
  const created = await fixture(browserPage);
  await browserPage.goto("/library/artists");

  await browserPage.getByRole("button", { name: "Collection Artist options" }).click();
  await browserPage.getByRole("menuitem", { name: "Add to playlist" }).click();
  await browserPage.getByRole("button", { name: "New playlist" }).click();

  await expect(browserPage.getByText("Collection Artist saved to Collection Artist Picks")).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0].name).toBe("Collection Artist Picks");
  expect(created[0].tracks.map((track) => [track.trackName, track.albumName])).toEqual([
    ["Morning", "Earlier Album"],
    ["Noon", "Earlier Album"],
    ["Gust", "Later Album"],
    ["Calm", "Later Album"],
  ]);
});
