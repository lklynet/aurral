import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const ARTIST_ID = "00000000-0000-4000-8000-000000001181";
const RELEASE_ID = "00000000-0000-4000-8000-000000001182";
const COVER = `https://assets.fanart.tv/fanart/music/${ARTIST_ID}/albumcover/cover.jpg?v=1`;
const NEXT_COVER = COVER.replace("cover.jpg", "next.jpg");
const OTHER_COVER = "https://images.example.test/fanart/cover.jpg";
const PLAYLIST_ID = "artwork-thumbnails";
const PLAYLIST_PATH = `/discover/playlists/deezer/${PLAYLIST_ID}`;
const release = {
  id: RELEASE_ID,
  title: "Thumbnail album",
  "primary-type": "Album",
  "first-release-date": "2026-01-01",
  coverUrl: COVER,
};
const artist = {
  id: ARTIST_ID,
  name: "Thumbnail artist",
  genres: [],
  "release-groups": [
    release,
    { ...release, id: "00000000-0000-4000-8000-000000001183", title: "Other provider", coverUrl: OTHER_COVER },
  ],
};

async function fixture(page, { missingPreviews = false, missingOriginal = false } = {}) {
  const imageRequests = [];
  const coverRequests = [];
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("https://assets.fanart.tv/**", (route) => {
    const url = new URL(route.request().url());
    imageRequests.push(url);
    const original = url.pathname.startsWith("/fanart/");
    const missing = (missingPreviews && !original && url.pathname.endsWith("/cover.jpg")) ||
      (missingOriginal && original);
    const size = original ? 1000 : url.pathname.startsWith("/bigpreview/") ? 400 : 200;
    return route.fulfill({
      status: missing ? 404 : 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: missing ? "" : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#b23c3c"/></svg>`,
    });
  });
  await page.route(OTHER_COVER, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"/>',
  }));
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const json = (body) => route.fulfill({ json: body });
    if (pathname === "/api/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (pathname === "/api/health") return json({ lidarrConfigured: true });
    if (pathname === "/api/discover") return json({ recommendations: [{ ...artist, image: COVER }], configured: true });
    if (pathname === "/api/discover/editorial") return json({ forYou: [], genres: [] });
    if (pathname === "/api/users/me/discover-layout") return json({ layout: [] });
    if (pathname === "/api/discover/feedback") return json({ feedback: [] });
    if (pathname === `/api/artists/${ARTIST_ID}/stream`) {
      const events = { artist, cover: { images: [] }, library: { exists: false }, similar: [], complete: {} };
      return route.fulfill({
        contentType: "text/event-stream",
        body: Object.entries(events).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      });
    }
    if (pathname === `/api/artists/release-group/${RELEASE_ID}`) return json(release);
    if (pathname.endsWith("/tracks")) return json({ tracks: [] });
    if (pathname.endsWith("/cover")) {
      coverRequests.push(pathname);
      return json({ images: [] });
    }
    if (pathname === "/api/artists/release-groups/covers") return json({ covers: {} });
    if (pathname === "/api/library/lookup/batch") return json({});
    if (pathname === "/api/library/favorites") return json({});
    if (pathname === "/api/settings") return json({});
    if (pathname === "/api/image-proxy") return json({ url: "/arralogo.svg" });
    if (pathname === `/api/discover/editorial/${PLAYLIST_ID}`) {
      return json({
        id: PLAYLIST_ID,
        name: "Artwork mix",
        tracks: [
          { trackName: "First artwork", artistName: artist.name, artworkUrl: COVER, preview_url: "/artwork-preview.wav" },
          { trackName: "Next artwork", artistName: artist.name, artworkUrl: NEXT_COVER, preview_url: "/artwork-preview.wav" },
          { trackName: "Local artwork", artistName: artist.name, artworkUrl: "/arralogo.svg" },
        ],
      });
    }
    return json([]);
  });
  await page.route("**/artwork-preview.wav", (route) => route.abort());
  return { imageRequests, coverRequests };
}

const loadedSource = (image) => image.evaluate((element) =>
  element.complete && element.naturalWidth > 0 ? element.currentSrc : null,
);
const albumImage = (page) => page.locator(".artist-release-card").filter({ hasText: release.title }).locator("img");

for (const density of [1, 2, 3]) {
  test.describe(`at ${density}x display density`, () => {
    test.use({ viewport: { width: 1024, height: 900 }, deviceScaleFactor: density });

    test("album cards request a matching preview and navigation keeps the original", async ({ page }, testInfo) => {
      const { imageRequests: requests } = await fixture(page);
      await page.goto(`/artist/${ARTIST_ID}`);
      const image = albumImage(page);
      await image.scrollIntoViewIfNeeded();
      const preview = density === 3 ? COVER : COVER.replace("/fanart/", density === 1 ? "/preview/" : "/bigpreview/");
      await expect.poll(() => loadedSource(image)).toBe(preview);
      expect(requests.filter((url) => url.href === COVER)).toHaveLength(density === 3 ? 1 : 0);
      const other = page.locator(".artist-release-card").filter({ hasText: "Other provider" }).locator("img");
      await expect.poll(() => loadedSource(other)).toBe(OTHER_COVER);
      await testInfo.attach("album-thumbnails", { body: await page.screenshot(), contentType: "image/png" });

      await page.getByRole("link", { name: release.title, exact: true }).click();
      const detail = page.locator(".native-library-detail__cover img");
      await expect.poll(() => loadedSource(detail)).toBe(COVER);
    });
  });
}

test("missing previews retry the original before giving up", async ({ page }) => {
  const { imageRequests: requests } = await fixture(page, { missingPreviews: true });
  await page.goto(`/artist/${ARTIST_ID}`);
  const image = albumImage(page);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => loadedSource(image)).toBe(COVER);
  expect(requests.some((url) => /\/(?:big)?preview\//.test(url.pathname))).toBe(true);
  expect(requests.filter((url) => url.href === COVER)).toHaveLength(1);
});

test("a failed preview and original retain the track's existing placeholder", async ({ page }) => {
  const { imageRequests: requests } = await fixture(page, { missingPreviews: true, missingOriginal: true });
  await page.goto(PLAYLIST_PATH);
  const row = page.locator(".native-library-track").filter({ hasText: "First artwork" });
  await expect(row).toBeVisible();
  await expect(row.locator(".native-library-cover-fallback")).toBeVisible();
  const local = page.locator(".native-library-track").filter({ hasText: "Local artwork" }).locator("img");
  await expect.poll(() => loadedSource(local)).toContain("/arralogo.svg");
  expect(requests.some((url) => /\/(?:big)?preview\//.test(url.pathname))).toBe(true);
  expect(requests.filter((url) => url.href === COVER)).toHaveLength(1);
});

test.describe("the mobile player", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("uses small artwork in the bar, resets fallback for the next track, and expands the original", async ({ page }, testInfo) => {
    const { imageRequests: requests } = await fixture(page, { missingPreviews: true });
    await page.goto(PLAYLIST_PATH);
    await page.getByRole("button", { name: `First artwork ${artist.name}`, exact: true }).click();
    const mini = page.locator(".global-player__art--mini img");
    await expect.poll(() => loadedSource(mini)).toBe(COVER);
    expect(requests.some((url) => /\/(?:big)?preview\//.test(url.pathname))).toBe(true);
    await page.locator(".global-player__mini").getByRole("button", { name: "Next track" }).click();
    await expect.poll(() => loadedSource(mini)).toBe(NEXT_COVER.replace("/fanart/", "/preview/"));
    await page.getByRole("button", { name: "Open now playing: Next artwork" }).click();
    const dialog = page.getByRole("dialog", { name: "Now playing" });
    await expect.poll(() => loadedSource(dialog.locator(".now-playing__art img"))).toBe(NEXT_COVER);
    await testInfo.attach("expanded-original-artwork", { body: await page.screenshot(), contentType: "image/png" });
    await dialog.getByRole("button", { name: "Close now playing" }).click();
    await expect(dialog).toHaveCount(0);
  });
});

test("artist cards retry the original before requesting replacement artwork", async ({ page }) => {
  const { imageRequests, coverRequests } = await fixture(page, { missingPreviews: true });
  await page.goto("/");
  const image = page.locator(".artist-discover-card__cover .artist-image-media").first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => loadedSource(image)).toBe(COVER);
  await expect(image).toHaveClass(/is-loaded/);
  expect(imageRequests.some((url) => /\/(?:big)?preview\//.test(url.pathname))).toBe(true);
  expect(coverRequests).toHaveLength(0);
});
