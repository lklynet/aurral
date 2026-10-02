import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials, useAurralWithoutLidarr } from "./helpers.js";

const artist = { mbid: "f22942a1-6f70-4f48-866e-238cb2308fbd", name: "Aphex Twin" };

requireCredentials();

async function ensureAurralArtist(page) {
  const existing = await apiRequest(page, `/api/library/artists/${artist.mbid}`);
  if (existing.status !== 404) {
    expect(
      existing.body?.managedBy,
      `${artist.name} is already in the library and is not managed by Aurral; use a fresh candidate database`,
    ).toBe("aurral");
    return existing.body;
  }
  const added = await apiRequest(page, "/api/library/artists", {
    method: "POST",
    body: { foreignArtistId: artist.mbid, artistName: artist.name, managedBy: "aurral" },
  });
  expect(added.ok).toBe(true);
  let record = null;
  await expect
    .poll(async () => {
      record = (await apiRequest(page, `/api/library/artists/${artist.mbid}`)).body;
      return record?.managedBy;
    }, { timeout: 30_000 })
    .toBe("aurral");
  return record;
}

async function openRemovalDialog(page, itemName, actionName) {
  await page.getByRole("button", { name: `${itemName} options` }).first().click();
  await page.getByRole("menuitem", { name: actionName, exact: true }).click();
  const dialogName = actionName;
  const dialog = page.getByRole("alertdialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  return dialog;
}

test("without Lidarr, an album and artist are deleted with their files", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const restoreLidarr = await useAurralWithoutLidarr(page);

  try {
    await ensureAurralArtist(page);
    await apiRequest(page, `/api/library/artists/${artist.mbid}`, {
      method: "PUT",
      body: { monitorOption: "none" },
    });

    const details = await apiRequest(page, `/api/artists/${artist.mbid}`);
    const releaseGroup = (details.body?.["release-groups"] || []).find(
      (entry) => entry["primary-type"] === "Album" && !(entry["secondary-types"] || []).length,
    );
    expect(releaseGroup, `${artist.name} has no studio album in the metadata provider`).toBeTruthy();
    await expect(async () => {
      const addedAlbum = await apiRequest(page, "/api/library/albums/request", {
        method: "POST",
        body: {
          albumMbid: releaseGroup.id,
          albumName: releaseGroup.title,
          artistName: artist.name,
          artistMbid: artist.mbid,
          managedBy: "aurral",
        },
      });
      expect(addedAlbum.ok, JSON.stringify(addedAlbum.body)).toBe(true);
    }).toPass({ timeout: 60_000 });

    let libraryAlbum = null;
    await expect
      .poll(async () => {
        const albums = await apiRequest(page, `/api/library/albums?artistId=${artist.mbid}`);
        libraryAlbum = (albums.body || []).find((album) => album.mbid === releaseGroup.id) || null;
        return libraryAlbum?.managedBy;
      }, { timeout: 30_000 })
      .toBe("aurral");

    await page.goto(`/library/album/${libraryAlbum.id}`);
    const albumDialog = await openRemovalDialog(page, releaseGroup.title, "Delete album");
    await albumDialog.getByLabel("Delete album files").check();
    await albumDialog.getByRole("button", { name: "Delete album" }).click();
    await expect(albumDialog).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Album deleted" })).toBeVisible();
    const albums = await apiRequest(page, `/api/library/albums?artistId=${artist.mbid}`);
    expect((albums.body || []).some((album) => album.mbid === releaseGroup.id)).toBe(false);

    const artistRecord = await apiRequest(page, `/api/library/artists/${artist.mbid}`);
    await page.goto(`/library/artist/${artistRecord.body.id}`);
    const artistDialog = await openRemovalDialog(page, artist.name, "Delete artist");
    await artistDialog.getByLabel("Delete artist files").check();
    await artistDialog.getByRole("button", { name: "Delete artist" }).click();
    await expect(artistDialog).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Artist deleted" })).toBeVisible();
    expect((await apiRequest(page, `/api/library/artists/${artist.mbid}`)).status).toBe(404);
  } finally {
    const leftover = await apiRequest(page, `/api/library/artists/${artist.mbid}`);
    if (leftover.status !== 404 && leftover.body?.managedBy === "aurral") {
      await apiRequest(page, `/api/library/artists/${artist.mbid}?deleteFiles=true`, { method: "DELETE" });
    }
    await restoreLidarr();
  }
});
