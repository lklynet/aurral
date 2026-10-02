import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = { id: 801, identityKey: "mbid:track-monitoring-artist", mbid: null, name: "Track Monitoring Artist" };

function createLibrary({ albumMonitored = true, pendingDownload = false } = {}) {
  const state = {
    albumMonitored,
    tracks: [
      { id: 811, title: "Kept Track", available: true, monitored: true },
      { id: 812, title: "Missing Track", available: false, monitored: true },
    ],
    pendingDownload,
    writes: [],
  };
  const track = (entry, index) => ({
    id: entry.id,
    canonicalId: String(entry.id),
    identityKey: `recording:${entry.id}`,
    mbid: null,
    title: entry.title,
    artistName: artist.name,
    monitored: entry.monitored,
    albums: [{ albumId: 802, discNumber: 1, trackNumber: index + 1 }],
    files: entry.available
      ? [{ id: entry.id, albumId: 802, source: "aurral", format: "flac", durationMs: 180000, available: true }]
      : [],
    sources: entry.available ? ["aurral"] : [],
    available: entry.available,
    managedBy: "aurral",
    monitorMode: null,
    source: entry.available ? "aurral" : null,
  });
  state.page = () => {
    const tracks = state.tracks.map(track);
    return {
      kind: "tracks",
      page: 1,
      pageSize: 100,
      total: tracks.length,
      hasMore: false,
      items: tracks,
      tracks,
      artists: [{ ...artist, albumIds: [802], managedBy: "aurral", sources: ["aurral"], available: true }],
      albums: [{
        id: 802,
        identityKey: "release-group:track-monitoring-album",
        mbid: null,
        releaseGroupMbid: null,
        artistId: artist.id,
        title: "Track Monitoring Album",
        metadata: { monitored: state.albumMonitored },
        trackIds: state.tracks.map((entry) => entry.id),
        managedBy: "aurral",
        monitorMode: state.albumMonitored ? null : "unmonitored",
        sources: ["aurral"],
        available: true,
        trackCount: state.tracks.length,
        availableTrackCount: state.tracks.filter((entry) => entry.available).length,
        coverUrl: null,
      }],
      genres: [],
    };
  };
  return state;
}

async function fixture(page, library) {
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") return json({ authRequired: false, onboardingRequired: false });
    if (path === "/health") return json({ lidarrConfigured: false });
    if (path === "/library/canonical") return json(library.page());
    const trackWrite = path.match(/^\/library\/tracks\/aurral\/(\d+)$/);
    if (trackWrite && request.method() === "PUT") {
      const { monitored } = request.postDataJSON();
      library.writes.push({ id: Number(trackWrite[1]), monitored });
      const entry = library.tracks.find((candidate) => candidate.id === Number(trackWrite[1]));
      entry.monitored = monitored;
      const cancelledJobIds = !monitored && library.pendingDownload && !entry.available ? ["fixture-job"] : [];
      if (cancelledJobIds.length) library.pendingDownload = false;
      return json({ canonicalId: String(entry.id), monitored, cancelledJobIds, queuedJobIds: [], cleanupFailed: false });
    }
    if (path === "/requests") {
      return json(library.pendingDownload
        ? [{
          kind: "track_download",
          playlistId: "library",
          status: "pending",
          jobId: "fixture-job",
          trackName: "Missing Track",
          artistName: artist.name,
          albumName: "Track Monitoring Album",
        }]
        : []);
    }
    if (path === "/library/downloads/status") return json({ 802: { status: "partial" } });
    if (path === "/library/albums/aurral/802/status") return json({ status: "partial" });
    if (path === "/settings") return json({});
    if (path === "/library/favorites") return json({});
    return json([]);
  });
}

const trackOptions = (page, title) => page.getByRole("button", { name: `${title} options`, exact: true });

const chooseFromTrackMenu = async (page, title, label) => {
  await trackOptions(page, title).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
};

const trackRow = (page, title) =>
  page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });

test("unmonitoring a track survives a reload and monitoring it again clears the marker", async ({ page }) => {
  const library = createLibrary();
  await fixture(page, library);
  await page.goto("/library/album/802");

  const row = trackRow(page, "Kept Track");
  await expect(row.getByRole("img", { name: "Not monitored" })).toHaveCount(0);
  await chooseFromTrackMenu(page, "Kept Track", "Stop monitoring track");
  await expect(page.getByRole("status").filter({ hasText: "Track unmonitored" })).toBeVisible();
  await expect(row.getByRole("img", { name: "Not monitored" })).toBeVisible();
  expect(library.writes).toEqual([{ id: 811, monitored: false }]);

  await page.reload();
  await expect(row.getByRole("img", { name: "Not monitored" })).toBeVisible();
  await trackOptions(page, "Kept Track").click();
  await expect(page.getByRole("menuitem", { name: "Monitor track", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trackRow(page, "Missing Track").getByRole("img", { name: "Not monitored" })).toHaveCount(0);

  await chooseFromTrackMenu(page, "Kept Track", "Monitor track");
  await expect(row.getByRole("img", { name: "Not monitored" })).toHaveCount(0);
  expect(library.writes).toEqual([{ id: 811, monitored: false }, { id: 811, monitored: true }]);
});

test("a track with an unfinished download asks before cancelling it", async ({ page }) => {
  const library = createLibrary({ pendingDownload: true });
  await fixture(page, library);
  await page.goto("/library/album/802");

  const trigger = trackOptions(page, "Missing Track");
  await chooseFromTrackMenu(page, "Missing Track", "Stop monitoring track");
  const dialog = page.getByRole("alertdialog", { name: "Stop monitoring this track?" });
  await expect(dialog).toContainText("unfinished download will be cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(library.writes).toEqual([]);

  await chooseFromTrackMenu(page, "Missing Track", "Stop monitoring track");
  await dialog.getByRole("button", { name: "Stop monitoring", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Track unmonitored. Cancelled 1 download." })).toBeVisible();
  await expect(trackRow(page, "Missing Track").getByRole("img", { name: "Not monitored" })).toBeVisible();
  expect(library.writes).toEqual([{ id: 812, monitored: false }]);
});

test("tracks in an unmonitored album explain why they cannot be toggled", async ({ page }) => {
  const library = createLibrary({ albumMonitored: false });
  await fixture(page, library);
  await page.goto("/library/album/802");

  await trackOptions(page, "Kept Track").click();
  await expect(page.getByRole("menuitem", { name: "Album isn't monitored", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Stop monitoring track", exact: true })).toHaveCount(0);
  expect(library.writes).toEqual([]);
});
