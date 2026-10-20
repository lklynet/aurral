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
    keepFile: entry.keepFile === true,
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
      await library.writeGate;
      if (library.failWrites) return json({ error: "Fixture write failed" }, 500);
      const { monitored, keepFile } = request.postDataJSON();
      const entry = library.tracks.find((candidate) => candidate.id === Number(trackWrite[1]));
      if (keepFile !== undefined) {
        library.writes.push({ id: entry.id, keepFile });
        entry.keepFile = keepFile;
        const cancelledJobIds = keepFile && library.upgrading ? ["fixture-upgrade"] : [];
        if (cancelledJobIds.length) library.upgrading = false;
        return json({ canonicalId: String(entry.id), keepFile, cancelledJobIds });
      }
      library.writes.push({ id: Number(trackWrite[1]), monitored });
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

test("keeping a file cancels its upgrade, survives a reload, and can be undone", async ({ page }) => {
  const library = createLibrary();
  library.upgrading = true;
  await fixture(page, library);
  await page.goto("/library/album/802");

  await trackOptions(page, "Missing Track").click();
  await expect(page.getByRole("menuitem", { name: "Keep this file", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await chooseFromTrackMenu(page, "Kept Track", "Keep this file");
  await expect(
    page.getByRole("status").filter({
      hasText: "Keeping Kept Track. Aurral won't replace it with an upgrade, and the upgrade in progress was cancelled.",
    }),
  ).toBeVisible();
  expect(library.writes).toEqual([{ id: 811, keepFile: true }]);

  await page.reload();
  await trackOptions(page, "Kept Track").click();
  await expect(page.getByRole("menuitem", { name: "Keep this file", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Allow upgrades", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Aurral can upgrade Kept Track again." })).toBeVisible();
  expect(library.writes).toEqual([{ id: 811, keepFile: true }, { id: 811, keepFile: false }]);
  expect(library.tracks.find((entry) => entry.id === 811).monitored).toBe(true);
});

test("a track with an unfinished download asks before cancelling it", async ({ page }) => {
  const library = createLibrary({ pendingDownload: true });
  await fixture(page, library);
  await page.goto("/library/album/802");

  const trigger = trackOptions(page, "Missing Track");
  await chooseFromTrackMenu(page, "Missing Track", "Stop monitoring track");
  const dialog = page.getByRole("alertdialog", { name: "Stop monitoring this track?" });
  await expect(dialog).toContainText("cancels its unfinished download");
  await expect(dialog).toContainText("The Library file stays.");
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

test("a track in an unmonitored album can still be unmonitored on its own", async ({ page }) => {
  const library = createLibrary({ albumMonitored: false });
  await fixture(page, library);
  await page.goto("/library/album/802");

  await chooseFromTrackMenu(page, "Kept Track", "Stop monitoring track");
  await expect(trackRow(page, "Kept Track").getByRole("img", { name: "Not monitored" })).toBeVisible();
  expect(library.writes).toEqual([{ id: 811, monitored: false }]);
});

test("stopping monitoring marks the track at once and takes the marker back if the server refuses", async ({ page }) => {
  const library = createLibrary();
  let releaseWrite;
  library.writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  library.failWrites = true;
  await fixture(page, library);
  await page.goto("/library/album/802");

  const row = trackRow(page, "Kept Track");
  await chooseFromTrackMenu(page, "Kept Track", "Stop monitoring track");
  await expect(row.getByRole("img", { name: "Not monitored" })).toBeVisible();
  releaseWrite();
  await expect(page.getByRole("alert").filter({ hasText: "Could not stop monitoring Kept Track. Nothing changed." })).toBeVisible();
  await expect(row.getByRole("img", { name: "Not monitored" })).toHaveCount(0);
});
