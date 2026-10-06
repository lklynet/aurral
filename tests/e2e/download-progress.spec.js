import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials, useAurralWithoutLidarr } from "./helpers.js";

const artist = { mbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", name: "Portishead" };
const release = { mbid: "1d1e0002-95ed-3c2c-b206-7bea41ef557d", title: "Machine Gun" };

requireCredentials();

test("a downloading album keeps its loading state across a page reload", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const restoreLidarr = await useAurralWithoutLidarr(page);
  const artistExisted = (await apiRequest(page, `/api/library/artists/${artist.mbid}`)).status !== 404;
  const lookupAlbum = async () =>
    (await apiRequest(page, "/api/library/albums/lookup/batch", {
      method: "POST",
      body: { mbids: [release.mbid] },
    })).body?.[release.mbid];
  expect(await lookupAlbum(), `${release.title} is already in the library; use a fresh candidate database`)
    .toBeFalsy();

  let albumRecordId = null;
  try {
    await page.goto(`/artist/${artist.mbid}/release/${release.mbid}`);
    await expect(page.getByRole("heading", { name: release.title, level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Download album", exact: true }).click();

    const downloading = page.getByRole("button", { name: "Downloading", exact: true });
    await expect(downloading).toBeVisible({ timeout: 30_000 });
    await expect(downloading).toBeDisabled();
    albumRecordId = (await lookupAlbum())?.albumRecordId || null;
    expect((await apiRequest(page, "/api/library/downloads/active")).body?.albums).toContain(release.mbid);
    await expect(page.getByRole("button", { name: /^Downloading / }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: release.title, level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(downloading).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Download album", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Downloading / }).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("album-downloading-after-reload.png") });
  } finally {
    albumRecordId ||= (await lookupAlbum())?.albumRecordId || null;
    if (albumRecordId) {
      await apiRequest(page, `/api/library/albums/aurral/${albumRecordId}/cancel`, { method: "POST" });
      await apiRequest(page, `/api/library/albums/aurral/${albumRecordId}?deleteFiles=true`, {
        method: "DELETE",
      });
    }
    if (!artistExisted) {
      await apiRequest(page, `/api/library/artists/${artist.mbid}?deleteFiles=true`, { method: "DELETE" });
    }
    await restoreLidarr();
  }
});
