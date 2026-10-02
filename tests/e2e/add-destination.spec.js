import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

const lidarrArtist = { mbid: "69158f97-4c07-4c4e-baf8-4e4ab1ed666e", name: "Boards of Canada" };

requireCredentials();

const lookupArtist = async (page, mbid) =>
  (await apiRequest(page, `/api/library/lookup/${mbid}`)).body;

async function tabTo(page, locator) {
  for (let step = 0; step < 120; step += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard focus never reached the Monitor button");
}

test("with Lidarr, Monitor adds an artist to Lidarr and changes its monitoring", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect(
    (await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}`)).status,
    `${lidarrArtist.name} must start outside the library; use a fresh candidate database`,
  ).toBe(404);

  try {
    await page.goto(`/artist/${lidarrArtist.mbid}`);
    await expect(page.getByRole("heading", { name: lidarrArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const actionBar = page.locator(".artist-action-bar");
    const monitor = actionBar.getByRole("button", { name: /^(Monitor|Monitoring: .*)$/ });
    await expect(monitor).toHaveAccessibleName("Monitor", { timeout: 30_000 });
    await expect(monitor).toHaveAttribute("aria-haspopup", "menu");

    await page.locator("body").focus();
    await tabTo(page, monitor);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Monitoring" });
    await expect(monitor).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(7);
    await expect(menu.getByRole("menuitem", { name: "Customize add…", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(monitor).toBeFocused();

    await monitor.click();
    await menu.getByRole("menuitemradio", { name: "Future albums", exact: true }).click();
    await expect(monitor).toHaveAccessibleName("Monitoring: Future albums", { timeout: 60_000 });
    await expect.poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 }).toBe(true);
    const monitoring = await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}/monitoring`);
    expect(monitoring.body).toMatchObject({ manager: "lidarr", added: true, monitorOption: "future" });

    await monitor.click();
    await expect(menu.getByRole("menuitem", { name: "Customize add…", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitemradio", { name: "Not monitored", exact: true }).click();
    await expect(monitor).toHaveAccessibleName("Monitor", { timeout: 60_000 });
  } finally {
    if ((await lookupArtist(page, lidarrArtist.mbid))?.exists) {
      const response = await apiRequest(
        page,
        `/api/library/artists/${lidarrArtist.mbid}?deleteFiles=false`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      await expect
        .poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 })
        .toBe(false);
    }
  }
});
