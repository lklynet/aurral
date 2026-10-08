import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials, useAurralWithoutLidarr } from "./helpers.js";

const artist = { mbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", name: "Portishead" };

requireCredentials();

const ACTIVE_STATUS = /^(queued|downloading)$/;

test("without Lidarr, an Aurral artist and album are monitored, unmonitored with a warning, and downloaded again", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const restoreLidarr = await useAurralWithoutLidarr(page);

  const existing = await apiRequest(page, `/api/library/artists/${artist.mbid}`);
  if (existing.status !== 404) {
    expect(
      existing.body?.managedBy,
      `${artist.name} is already in the library and is not managed by Aurral; use a fresh candidate database`,
    ).toBe("aurral");
  }

  const albumMonitoringWrites = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/library\/albums\/aurral\//.test(request.url())) {
      albumMonitoringWrites.push(request.url());
    }
  });

  let albumId = null;
  try {
    if (existing.status === 404) {
      const added = await apiRequest(page, "/api/library/artists", {
        method: "POST",
        body: { foreignArtistId: artist.mbid, artistName: artist.name, managedBy: "aurral" },
      });
      expect(added.ok).toBe(true);
    }
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/artists/${artist.mbid}`)).body?.managedBy, {
        timeout: 30_000,
      })
      .toBe("aurral");

    await page.goto(`/artist/${artist.mbid}`);
    await expect(page.getByRole("heading", { name: artist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const actionBar = page.locator(".artist-action-bar");
    await actionBar.getByRole("button", { name: /^(Monitor|Monitoring: .*)$/ }).click();
    await expect(page.getByRole("menuitemradio", { name: "Not monitored", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio")).toHaveText([
      "Not monitored",
      "All albums",
      "Future albums",
      "Latest album",
      "First album",
    ]);

    await page.getByRole("menuitemradio", { name: "Latest album", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued 1 album for download" })).toBeVisible({
      timeout: 60_000,
    });

    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums?artistId=${artist.mbid}`)).body?.length, {
        timeout: 60_000,
      })
      .toBe(1);
    const albums = await apiRequest(page, `/api/library/albums?artistId=${artist.mbid}`);
    albumId = albums.body[0].id;
    expect(albums.body[0].managedBy).toBe("aurral");

    await page.goto(`/library/album/${albumId}`);
    const albumOptions = page.getByRole("button", { name: `${albums.body[0].title} options`, exact: true });
    const unmonitoredMark = page.locator(".native-library-detail__manager");
    const chooseMonitoring = async (label) => {
      await albumOptions.click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await expect(page.getByRole("heading", { name: albums.body[0].title })).toBeVisible({ timeout: 30_000 });
    await expect(unmonitoredMark).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /Queued|Downloading/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    await chooseMonitoring("Stop monitoring album");
    const dialog = page.getByRole("alertdialog", { name: "Stop monitoring this album?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Unfinished downloads will be cancelled");
    expect(albumMonitoringWrites).toHaveLength(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(albumOptions).toBeFocused();
    await expect(unmonitoredMark).toHaveCount(0);
    expect(albumMonitoringWrites).toHaveLength(0);
    expect((await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status).toMatch(
      ACTIVE_STATUS,
    );

    await chooseMonitoring("Stop monitoring album");
    await dialog.getByRole("button", { name: "Stop monitoring", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Cancelled \d+ downloads?/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(unmonitoredMark).toHaveAccessibleName("Not monitored");
    expect(albumMonitoringWrites).toHaveLength(1);
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status, {
        timeout: 30_000,
      })
      .not.toMatch(ACTIVE_STATUS);

    await albumOptions.click();
    await expect(page.getByRole("menuitem", { name: "Stop monitoring album", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Monitor album", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: `Download ${albums.body[0].title}`, exact: true }).click();
    await expect(unmonitoredMark).toHaveCount(0);
    expect(albumMonitoringWrites).toHaveLength(1);
    await expect(page.getByRole("status").filter({ hasText: /Queued|Downloading/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status, {
        timeout: 30_000,
      })
      .toMatch(ACTIVE_STATUS);
    await page.screenshot({ path: test.info().outputPath("album-downloaded-again.png") });
  } finally {
    if (albumId) {
      await apiRequest(page, `/api/library/albums/aurral/${albumId}/cancel`, { method: "POST" });
    }
    await apiRequest(page, `/api/library/artists/${artist.mbid}`, {
      method: "PUT",
      body: { monitorOption: "none" },
    });
    await restoreLidarr();
  }
});
