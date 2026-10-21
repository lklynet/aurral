import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = { id: 901, identityKey: "mbid:box-set-artist", mbid: null, name: "Box Set Artist" };
const trackIds = Array.from({ length: 105 }, (_, index) => 9001 + index);

const track = (id: number, index: number) => ({
  id,
  canonicalId: String(id),
  identityKey: `recording:${id}`,
  mbid: null,
  title: `Box Set Track ${index + 1}`,
  artistName: artist.name,
  monitored: true,
  albums: [{ albumId: 902, discNumber: 1, trackNumber: index + 1 }],
  files:
    index === 0
      ? [
          {
            id,
            albumId: 902,
            source: "aurral",
            format: "flac",
            durationMs: 180000,
            available: true,
          },
        ]
      : [],
  sources: index === 0 ? ["aurral"] : [],
  available: index === 0,
  managedBy: "aurral",
  monitorMode: null,
  source: index === 0 ? "aurral" : null,
});

function libraryPage(url: URL) {
  const number = Number(url.searchParams.get("page")) || 1;
  const size = Number(url.searchParams.get("pageSize")) || 100;
  const items = trackIds
    .slice((number - 1) * size, number * size)
    .map((id) => track(id, trackIds.indexOf(id)));
  return {
    kind: "tracks",
    page: number,
    pageSize: size,
    total: trackIds.length,
    hasMore: number * size < trackIds.length,
    items,
    tracks: items,
    artists: [
      { ...artist, albumIds: [902], managedBy: "aurral", sources: ["aurral"], available: true },
    ],
    albums: [
      {
        id: 902,
        identityKey: "release-group:box-set-album",
        mbid: null,
        releaseGroupMbid: null,
        artistId: artist.id,
        title: "Box Set Album",
        metadata: { monitored: false },
        trackIds,
        managedBy: "aurral",
        monitorMode: null,
        sources: ["aurral"],
        available: true,
        trackCount: trackIds.length,
        availableTrackCount: 1,
        coverUrl: null,
      },
    ],
    genres: [],
  };
}

test("an album with more tracks than one page lists every track", async ({ page }) => {
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });
    if (path === "/health/bootstrap")
      return json({ authRequired: false, onboardingRequired: false });
    if (path === "/health") return json({ lidarrConfigured: false });
    if (path === "/library/canonical") return json(libraryPage(url));
    if (path === "/settings" || path === "/library/favorites") return json({});
    return json([]);
  });

  await page.goto("/library/album/902");

  await expect(page.getByText("Box Set Track 100", { exact: true }).first()).toBeAttached();
  await expect(page.getByText("Box Set Track 105", { exact: true }).first()).toBeAttached();
});
