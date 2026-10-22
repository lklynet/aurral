import { expect, test } from "@playwright/test";
import sharp from "sharp";

const artist = {
  id: "41",
  canonicalId: "41",
  name: "Local Artist",
  artistName: "Local Artist",
  mbid: null,
  albumIds: ["42"],
  albumCount: 1,
  available: true,
  images: [],
};
const album = {
  id: "42",
  artistId: "41",
  title: "Unidentified Album",
  albumArtist: artist.name,
  mbid: null,
  releaseGroupMbid: null,
  available: true,
  trackIds: ["43"],
  trackCount: 1,
  availableTrackCount: 1,
  coverUrl: "/api/library/albums/42/cover",
  sources: ["aurral"],
};
const track = {
  id: "43",
  title: "Local Song",
  artistName: artist.name,
  durationMs: 8000,
  albums: [{ albumId: "42", discNumber: 1, trackNumber: 1 }],
  available: true,
  monitored: true,
  files: [
    { id: "44", albumId: "42", source: "aurral", available: true, format: "wav", durationMs: 8000 },
  ],
};
const coverImage = await sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 32, g: 130, b: 190 } },
})
  .webp()
  .toBuffer();
const wav = Buffer.alloc(44 + 8000 * 8 * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let n = 0; n < (wav.length - 44) / 2; n++)
  wav.writeInt16LE(Math.round(1000 * Math.sin((n * Math.PI) / 20)), 44 + n * 2);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("auth_token", "fixture-token"));
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body) => route.fulfill({ json: body });
    if (path === "/health/bootstrap")
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: false });
    if (path.startsWith("/health")) return json({ lidarrConfigured: false });
    if (path === "/auth/me")
      return json({ user: { id: "1", username: "Fixture", role: "admin", permissions: {} } });
    if (path === "/library/canonical") {
      const kind = url.searchParams.get("kind") || "artists";
      const items = kind === "artists" ? [artist] : kind === "albums" ? [album] : [track];
      return json({
        kind,
        items,
        artists: [artist],
        albums: [album],
        tracks: [track],
        total: 1,
        page: 1,
        pageSize: 100,
        hasMore: false,
        genres: [],
      });
    }
    if (path === "/library/albums/42/cover") {
      if (url.searchParams.get("token") !== "fixture-token")
        return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
      return route.fulfill({ contentType: "image/webp", body: coverImage });
    }
    if (path === "/library/canonical-stream/42/43") {
      const range = req.headers().range?.match(/bytes=(\d+)-(\d*)/);
      const start = Number(range?.[1] || 0);
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        body: wav.subarray(start, end + 1),
        headers: {
          "Content-Type": "audio/wav",
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}),
        },
      });
    }
    if (path === "/playlists/status") return json({ flows: [], sharedPlaylists: [], worker: {} });
    if (path === "/settings") return json({});
    if (path === "/library/favorites" || path === "/artists/release-groups/covers") return json({});
    return json([]);
  });
});

test("unidentified local album artwork authenticates in the library and playing audio", async ({
  page,
}) => {
  await page.goto("/library/albums");
  const cover = page.locator('img[src*="/api/library/albums/42/cover"]').first();
  await expect(cover).toHaveAttribute(
    "src",
    /\/api\/library\/albums\/42\/cover\?token=fixture-token/,
  );
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("local-album-library.png"),
    animations: "disabled",
  });
  await page
    .getByRole("article")
    .getByRole("link", { name: "Open Unidentified Album", exact: true })
    .click();
  await expect(page).toHaveURL(/\/library\/album\/42$/);
  await page.getByRole("button", { name: "Play Local Song", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      Number(await page.getByRole("slider", { name: "Playback position" }).inputValue()),
    )
    .toBeGreaterThan(0.1);
  const playerArt = page.locator(".global-player__art--bar img");
  await expect(playerArt).toHaveAttribute(
    "src",
    /\/api\/library\/albums\/42\/cover\?token=fixture-token/,
  );
  await expect
    .poll(() => playerArt.evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("local-album-playing.png"),
    animations: "disabled",
  });
});

test("an album without local artwork retains its letter placeholder in the grid and header", async ({
  page,
}) => {
  await page.route("**/api/library/albums/42/cover**", (route) =>
    route.fulfill({ status: 404, json: { error: "Album cover not found" } }),
  );
  await page.goto("/library/albums");
  const card = page.getByRole("article");
  await expect(card.getByRole("img", { name: album.title, exact: true })).toHaveText("U");
  await page.screenshot({
    path: test.info().outputPath("no-artwork-library.png"),
    animations: "disabled",
  });
  await card.getByRole("link", { name: "Open Unidentified Album", exact: true }).click();
  await expect(
    page
      .locator(".native-library-detail__cover")
      .getByRole("img", { name: album.title, exact: true }),
  ).toHaveText("U");
});

test("playing an album without local artwork retains the player and queue music placeholders", async ({
  page,
}) => {
  await page.route("**/api/library/albums/42/cover**", (route) =>
    route.fulfill({ status: 404, json: { error: "Album cover not found" } }),
  );
  await page.goto("/library/album/42");
  await page.getByRole("button", { name: "Play Local Song", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const art = page.locator(".global-player__art--bar");
  await expect(art.locator("img")).toHaveCount(0);
  await expect(art.locator("svg")).toBeVisible();
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator(".player-queue__art img")).toHaveCount(0);
  await expect(page.locator(".player-queue__art svg").first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("no-artwork-playing.png"),
    animations: "disabled",
  });
});
