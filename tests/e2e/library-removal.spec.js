import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

const artist = { mbid: "f22942a1-6f70-4f48-866e-238cb2308fbd", name: "Aphex Twin" };

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

async function openApp(page) {
  await page.goto("/");
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
}

async function apiRequest(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const token = localStorage.getItem("auth_token");
    const headers = {
      ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      credentials: "include",
      cache: "no-store",
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, { requestPath: path, requestMethod: method, requestBody: body });
}

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

async function openRemovalDialog(page, itemName, dialogName) {
  await page.getByRole("button", { name: `${itemName} options` }).first().click();
  await page.getByRole("menuitem", { name: "Remove from library" }).click();
  const dialog = page.getByRole("alertdialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  return dialog;
}

test("an Aurral album and artist are removed with their files", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);

  try {
    await ensureAurralArtist(page);
    await apiRequest(page, `/api/library/artists/${artist.mbid}`, {
      method: "PUT",
      body: { monitored: false, monitorOption: "none" },
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
    const albumDialog = await openRemovalDialog(page, releaseGroup.title, "Remove album from library");
    await albumDialog.getByLabel("Delete album files").check();
    await albumDialog.getByRole("button", { name: "Remove album" }).click();
    await expect(albumDialog).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Album removed from library" })).toBeVisible();
    const albums = await apiRequest(page, `/api/library/albums?artistId=${artist.mbid}`);
    expect((albums.body || []).some((album) => album.mbid === releaseGroup.id)).toBe(false);

    await page.goto(`/artist/${artist.mbid}`);
    await expect(page.getByRole("heading", { name: artist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const actionBar = page.locator(".artist-action-bar");
    await actionBar.getByRole("button", { name: /In library/ }).click();
    await actionBar.getByRole("button", { name: "Remove from Library" }).click();
    const artistDialog = page.getByRole("alertdialog", { name: "Remove Artist from Library" });
    await expect(artistDialog).toBeVisible();
    await expect(artistDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await artistDialog.getByLabel("Delete artist files").check();
    await artistDialog.getByRole("button", { name: "Remove Artist" }).click();
    await expect(artistDialog).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByRole("status").filter({ hasText: `Successfully removed ${artist.name} from library and deleted files` }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: artist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(actionBar.getByRole("button", { name: /In library/ })).toHaveCount(0);
    expect((await apiRequest(page, `/api/library/artists/${artist.mbid}`)).status).toBe(404);
  } finally {
    const leftover = await apiRequest(page, `/api/library/artists/${artist.mbid}`);
    if (leftover.status !== 404 && leftover.body?.managedBy === "aurral") {
      await apiRequest(page, `/api/library/artists/${artist.mbid}?deleteFiles=true`, { method: "DELETE" });
    }
  }
});
