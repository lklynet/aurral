import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

const linkedMbid = "10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8";

requireCredentials();

async function findUntaggedArtist(page) {
  const response = await apiRequest(page, "/api/library/canonical?kind=artists&pageSize=100");
  expect(response.ok).toBe(true);
  const artist = (response.body?.items || []).find((item) => !item.mbid && item.providerId == null);
  expect(artist, "The candidate library needs an untagged Aurral artist such as the playback fixture").toBeTruthy();
  return artist;
}

test("library and Discover artist pages link to each other", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const artist = await findUntaggedArtist(page);
  const libraryPath = `/library/artist/${encodeURIComponent(artist.id)}`;
  const openInDiscover = page.getByRole("link", { name: "Open in Discover", exact: true });
  const openInLibrary = page.getByRole("link", { name: "Open in library", exact: true });

  await page.goto(libraryPath);
  await expect(page.getByRole("heading", { name: artist.name })).toBeVisible();
  await expect(openInDiscover).toHaveCount(0);

  let linked = null;
  try {
    linked = await apiRequest(page, `/api/library/canonical/artists/${artist.id}/mbid`, {
      method: "PUT",
      body: { mbid: linkedMbid },
    });
    expect(linked.ok, `Linking the MusicBrainz ID failed with ${linked.status}`).toBe(true);
    expect(linked.body?.merged).toBe(false);

    await page.reload();
    await openInDiscover.click();
    await expect(page).toHaveURL(new RegExp(`/artist/${linkedMbid}$`));
    await expect(openInLibrary).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("discover-view.png") });

    await openInLibrary.click();
    await expect(page).toHaveURL(new RegExp(`${libraryPath}$`));
    await expect(openInDiscover).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("library-view.png") });

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/artist/${linkedMbid}$`));
  } finally {
    if (linked?.ok && linked.body?.merged === false) {
      const restored = await apiRequest(page, `/api/library/canonical/artists/${artist.id}/mbid`, {
        method: "PUT",
        body: { mbid: null },
      });
      expect(restored.ok, `Restoring the untagged artist failed with ${restored.status}`).toBe(true);
    }
  }
});
