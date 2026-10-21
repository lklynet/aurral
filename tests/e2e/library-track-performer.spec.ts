import { expect, test, type Page } from "@playwright/test";
import type { AurralRequestItem } from "../../backend/services/aurralHistoryService.ts";

declare global {
  interface Window {
    sharedTrack?: { url: string };
  }
}

type PlaylistWriteBody = { name: string; tracks: unknown[] };
type DownloadWriteBody = {
  artistName: string;
  artistMbid: string;
  trackName: string;
  albumName: string;
  albumMbid: string;
  canonicalTrackId: string;
};
type WriteRecord = { path: string; body: PlaylistWriteBody | DownloadWriteBody };

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const ownerMbid = "11111111-1111-4111-8111-111111111111";
const albumMbid = "22222222-2222-4222-8222-222222222222";
const trackMbid = "33333333-3333-4333-8333-333333333333";
const artist = {
  id: "41",
  identityKey: `mbid:${ownerMbid}`,
  name: "Owner",
  mbid: ownerMbid,
  albumIds: ["42"],
  albumCount: 1,
  available: true,
  sources: ["aurral"],
};
const album = {
  id: "42",
  identityKey: `release-group:${albumMbid}`,
  artistId: "41",
  title: "Album",
  albumArtist: "Owner",
  mbid: null,
  releaseGroupMbid: albumMbid,
  available: true,
  managedBy: "aurral",
  trackIds: ["43", "45", "46", "47"],
  trackCount: 4,
  availableTrackCount: 3,
  sources: ["aurral"],
};
const track = (
  id: string,
  title: string,
  artistName: string,
  trackNumber: number,
  available = true,
) => ({
  id,
  identityKey: `track:${id}`,
  title,
  artistName,
  mbid: id === "43" ? trackMbid : null,
  durationMs: 60_000,
  albums: [{ albumId: "42", discNumber: 1, trackNumber }],
  available,
  monitored: true,
  files: available
    ? [{ id, albumId: "42", source: "aurral", available: true, format: "wav", durationMs: 60_000 }]
    : [],
  sources: available ? ["aurral"] : [],
});
const guest = track("43", "A guest song", "Guest & Owner", 1);
const owner = track("45", "M owner song", "Owner", 2);
const alpha = track("46", "Z alpha song", "Alpha", 3);
const missing = track("47", "Missing guest song", "Guest & Owner", 4, false);

const wav = Buffer.alloc(44 + 60 * 8000, 128);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);

async function fixture(
  page: Page,
  {
    ownerArtistMbid = ownerMbid,
    activity = [],
  }: { ownerArtistMbid?: string | null; activity?: Partial<AurralRequestItem>[] } = {},
) {
  const writes: WriteRecord[] = [];
  const albumArtist = {
    ...artist,
    mbid: ownerArtistMbid,
    identityKey: ownerArtistMbid ? `mbid:${ownerArtistMbid}` : "name:artist:owner",
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      value: async (data: { url: string }) => {
        window.sharedTrack = data;
      },
    });
  });
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/health/bootstrap")
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: false });
    if (path.startsWith("/health")) return json({ lidarrConfigured: false });
    if (path === "/library/canonical") {
      const kind = url.searchParams.get("kind") || "artists";
      const tracks = url.searchParams.has("albumId")
        ? [guest, owner, alpha, missing]
        : [guest, owner, alpha];
      const items = kind === "artists" ? [albumArtist] : kind === "albums" ? [album] : tracks;
      return json({
        kind,
        items,
        artists: [albumArtist],
        albums: [album],
        tracks,
        total: items.length,
        page: 1,
        pageSize: 100,
        hasMore: false,
        genres: [],
      });
    }
    if (path.startsWith("/library/canonical-stream/")) {
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers().range || "");
      const start = Number(range?.[1] || 0);
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        body: wav.subarray(start, end + 1),
        headers: {
          "Content-Type": "audio/wav",
          "Accept-Ranges": "bytes",
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}),
        },
      });
    }
    if (path === "/playlists/shared-playlists" && request.method() === "POST") {
      writes.push({ path, body: request.postDataJSON() });
      return json({ success: true, playlistId: "created", queued: true });
    }
    if (path === "/library/downloads/track" && request.method() === "POST") {
      writes.push({ path, body: request.postDataJSON() });
      return json({ success: true, queued: true, jobId: "fixture-job" });
    }
    if (path === "/share-links/availability")
      return json({ trackCount: 1, tunnelAvailable: false });
    if (path === "/requests") return json(activity);
    if (path === "/playlists/status") return json({ sharedPlaylists: [], flows: [], worker: {} });
    if (
      path === "/settings" ||
      path === "/library/favorites" ||
      path === "/artists/release-groups/covers"
    )
      return json({});
    return json([]);
  });
  return writes;
}

test("track rows, playback and search keep the performer credit", async ({ page }) => {
  await fixture(page);
  await page.goto("/library/tracks");
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `${guest.title} options`, exact: true }) });
  await expect(row).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("track-performer.png"),
    animations: "disabled",
  });
  await expect(row.locator(".native-library-track__artist")).toHaveText("Guest & Owner");
  await expect(row.getByRole("link", { name: "Guest & Owner", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Owner", exact: true })).toHaveAttribute(
    "href",
    "/library/artist/41",
  );
  await row.getByRole("button", { name: `Play ${guest.title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator(".global-player__subtitle").first()).toContainText("Guest & Owner");
  await expect(
    page
      .locator(".global-player__subtitle")
      .first()
      .getByRole("link", { name: "Guest & Owner", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Search tracks", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search tracks", exact: true }).fill("Guest");
  await expect(row).toBeVisible();
  await expect(page.getByRole("button", { name: `Play ${owner.title}`, exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("searchbox", { name: "Search tracks", exact: true }).fill("Owner");
  await expect(
    page.getByRole("button", { name: `Play ${alpha.title}`, exact: true }),
  ).toBeVisible();
});

test("a track credited to its album owner keeps the owner link without an MBID", async ({
  page,
}) => {
  await fixture(page, { ownerArtistMbid: null });
  await page.goto("/library/tracks");
  await expect(page.getByRole("link", { name: "Owner", exact: true })).toHaveAttribute(
    "href",
    "/library/artist/41",
  );
  await page.getByRole("link", { name: "Owner", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/artist\/41$/);
});

test("artist sorting uses each track's performer", async ({ page }) => {
  await fixture(page);
  await page.goto("/library/tracks?sort=artist");
  await expect(page.locator(".native-library-track__title > span")).toHaveText([
    "Z alpha song",
    "A guest song",
    "M owner song",
  ]);
});

test("track information uses the performer credit", async ({ page }) => {
  await fixture(page);
  await page.goto("/library/tracks");
  await page.getByRole("button", { name: `${guest.title} options`, exact: true }).click();
  await page.getByRole("menuitem", { name: "View info", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "A guest song", exact: true });
  await expect(
    dialog
      .locator(".activity-info-modal__row")
      .filter({ has: page.getByText("Artist", { exact: true }) }),
  ).toHaveText("ArtistGuest & Owner");
});

test("playlist payloads keep the album owner's acquisition identity", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/library/tracks");
  for (const entry of [guest, owner]) {
    await page.getByRole("button", { name: `${entry.title} options`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Add to playlist", exact: true }).click();
    await page.getByRole("button", { name: "New playlist", exact: true }).click();
    await expect.poll(() => writes.length).toBe(entry === guest ? 1 : 2);
  }
  expect(writes[0].body.name).toBe("Guest & Owner Picks");
  expect(writes[0].body.tracks[0]).toMatchObject({
    artistName: "Owner",
    artistMbid: ownerMbid,
    trackName: "A guest song",
    albumName: "Album",
    albumMbid,
    trackMbid,
  });
  expect(writes[1].body.tracks[0]).toMatchObject({ artistName: "Owner", artistMbid: ownerMbid });
});

test("a shared track carries the performer credit without the owner's artist identity", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/library/tracks");
  await page.getByRole("button", { name: `${guest.title} options`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Share track", exact: true })
    .getByRole("button", { name: "Share link", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => window.sharedTrack?.url)).toBeTruthy();
  const url = await page.evaluate(() => window.sharedTrack!.url);
  const payload = Buffer.from(new URL(url).pathname.split("/").at(-1)!, "base64url");
  expect([...payload.subarray(0, 3)]).toEqual([1, 3, 3]);
  expect(payload.subarray(3, 19).toString("hex")).toBe("33333333333343338333333333333333");
  expect(payload.subarray(19, 35).toString("hex")).toBe("22222222222242228222222222222222");
  expect(payload.subarray(35).toString("utf8").split("\0")).toEqual([
    "A guest song",
    "Guest & Owner",
    "Album",
  ]);
});

test("a missing track request retains album owner identity and canonical references", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto("/library/album/42");
  await page.getByRole("button", { name: `${missing.title} options`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Download track", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: "/library/downloads/track",
    body: {
      artistName: "Owner",
      artistMbid: ownerMbid,
      trackName: "Missing guest song",
      albumName: "Album",
      albumMbid,
      canonicalTrackId: "47",
    },
  });
});

for (const [state, status, statusLabel, actionLabel] of [
  ["blocked", "blocked", "Needs review", "Needs review"],
  ["searching", "processing", "Searching Soulseek", "Searching for track…"],
  ["moving", "processing", "Moving files", "Adding to library…"],
]) {
  test(`reopening a guest track's album restores ${state} activity under the album owner`, async ({
    page,
  }) => {
    await fixture(page, {
      activity: [
        {
          kind: "track_download",
          playlistId: "library",
          jobId: `${state}-job`,
          status,
          statusLabel,
          trackName: "Missing guest song",
          artistName: "Owner",
          albumName: "Album",
        },
      ],
    });
    await page.goto("/library/album/42");
    const row = page.getByRole("listitem").filter({
      has: page.getByRole("button", { name: "Missing guest song options", exact: true }),
    });
    await expect(row.getByRole("button", { name: actionLabel, exact: true })).toBeDisabled();

    await page.goto("/library/tracks");
    await page.getByRole("link", { name: "Open Album", exact: true }).first().click();

    await expect(row.getByRole("button", { name: actionLabel, exact: true })).toBeDisabled();
  });
}
