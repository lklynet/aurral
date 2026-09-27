import { isIP } from "node:net";
import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the YouTube Music browser journey");
  }
});

async function signIn(page) {
  await page.goto("/playlists");
  const signInHeading = page.getByRole("heading", { name: "Sign in" });
  const playlistsHeading = page.getByRole("heading", { name: "Playlists", exact: true });
  await expect(signInHeading.or(playlistsHeading)).toBeVisible();
  if (!await signInHeading.isVisible()) return;
  const signInUrl = new URL(page.url());
  const hostname = signInUrl.hostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (signInUrl.protocol !== "https:" && !isLoopback) {
    throw new Error("Refusing to submit test credentials over insecure transport");
  }
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(playlistsHeading).toBeVisible();
}

async function openImport(page, { selectYoutube = true } = {}) {
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.getByRole("menuitem", { name: "Import playlist" }).click();
  await expect(page.getByRole("heading", { name: "Import playlist" })).toBeVisible();
  if (selectYoutube) {
    await page.getByRole("button", { name: "YouTube Music", exact: true }).click();
  }
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`YouTube Music import handles preview, recovery, reset, and import on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let previewMode = "error";
    let releasePreview;
    let importPayload;

    await page.route("**/api/playlists/import/spotify/status", (route) =>
      route.fulfill({ json: { connected: false, displayName: null } }));
    await page.route("**/api/playlists/import/youtube-music/preview", async (route) => {
      if (previewMode === "error") {
        await route.fulfill({
          status: 502,
          json: { error: "Failed to preview YouTube Music playlist", message: "Playlist unavailable" },
        });
        return;
      }
      if (previewMode === "loading") {
        await new Promise((resolve) => { releasePreview = resolve; });
      }
      const zero = previewMode === "zero";
      await route.fulfill({
        json: {
          playlist: { id: "PLabcdefghij_123", name: "Public test playlist" },
          trackCount: zero ? 0 : 4,
          skipped: zero ? 2 : 1,
          previewTracks: zero ? [] : [
            { artistName: "Artist A", trackName: "Track A", albumName: "Album A" },
            { artistName: "Artist B", trackName: "Track B", albumName: null },
          ],
        },
      });
    });
    await page.route("**/api/playlists/import/youtube-music", async (route) => {
      importPayload = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, queued: true, tracksQueued: 4 } });
    });

    await signIn(page);
    await openImport(page);
    const urlInput = page.getByLabel("Playlist URL");
    const loadButton = page.getByRole("button", { name: "Load playlist" });
    const testUrl = "https://music.youtube.com/playlist?list=PLabcdefghij_123";

    await urlInput.fill(testUrl);
    await loadButton.click();
    await expect(page.getByRole("alert")).toContainText("Playlist unavailable");
    await expect(urlInput).toHaveValue(testUrl);

    previewMode = "zero";
    await urlInput.press("Enter");
    await expect(page.getByText("0 importable")).toBeVisible();
    await expect(page.getByText(/No importable tracks were found/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Import playlist", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "JSON file", exact: true }).click();
    await page.getByRole("button", { name: "YouTube Music", exact: true }).click();
    await expect(urlInput).toHaveValue("");

    await urlInput.fill(testUrl);
    previewMode = "loading";
    await loadButton.click();
    await expect(page.getByRole("button", { name: "Loading preview…" })).toBeDisabled();
    releasePreview();
    await expect(page.getByText("Public test playlist")).toBeVisible();
    await expect(page.getByText("4 importable")).toBeVisible();
    await expect(page.getByText("Artist A — Track A", { exact: false })).toBeVisible();

    await page.getByLabel("Name in Aurral").fill("Imported YouTube mix");
    await page.getByLabel("Sync").selectOption("12");
    await page.getByLabel("Keep removed tracks in library").uncheck();
    await page.getByRole("button", { name: "Import playlist", exact: true }).click();
    await expect.poll(() => importPayload).toEqual({
      playlistId: "PLabcdefghij_123",
      name: "Imported YouTube mix",
      syncEnabled: true,
      syncIntervalHours: 12,
      keepRemovedTracks: false,
    });

    await openImport(page, { selectYoutube: false });
    await expect(page.getByRole("button", { name: "Spotify", exact: true })).toHaveClass(/is-active/);
    await page.getByRole("button", { name: "YouTube Music", exact: true }).click();
    await expect(page.getByLabel("Playlist URL")).toHaveValue("");
    await page.getByLabel("Playlist URL").focus();
    await expect(page.getByLabel("Playlist URL")).toBeFocused();
  });
}
