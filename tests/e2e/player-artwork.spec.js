import { expect, test } from "@playwright/test";

const RELEASE_GROUP_MBID = "00000000-0000-4000-8000-00000000e2e1";
const COVER = "/arralogo.svg";

test("the player finds a missing cover and the album-art theme follows it", async ({ page }) => {
  let coverAvailable = false;
  const coverRequests = [];

  await page.route("**/api/library/canonical?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const album of body.albums || []) {
      album.releaseGroupMbid = RELEASE_GROUP_MBID;
      album.coverUrl = null;
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/artists/release-groups/covers", async (route) => {
    const { items } = route.request().postDataJSON();
    coverRequests.push(...items.map((item) => item.mbid));
    const cover = coverAvailable
      ? { image: COVER, notFound: false }
      : { image: null, notFound: false, transientError: true };
    await route.fulfill({
      json: { covers: Object.fromEntries(items.map((item) => [item.mbid, cover])) },
    });
  });

  await page.goto("/profile");
  const matchArtwork = page.getByRole("switch", { name: "Match album art" });
  const wasMatching = (await matchArtwork.getAttribute("aria-checked")) === "true";
  if (!wasMatching) await matchArtwork.click();
  await expect(matchArtwork).toHaveAttribute("aria-checked", "true");

  try {
    await page.goto("/library/tracks");
    const play = page.getByRole("main").getByRole("button", { name: /^Play (?!Tracks$)/ }).first();
    await expect(play).toBeVisible();
    const accent = () =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--aurral-accent"));
    const accentBefore = await accent();

    coverAvailable = true;
    await play.click();

    const playerArt = page.locator(".global-player__art--bar img");
    await expect(playerArt).toHaveAttribute("src", COVER);
    expect(coverRequests).toContain(RELEASE_GROUP_MBID);
    await expect.poll(accent).not.toBe(accentBefore);
    await expect.poll(accent).toMatch(/^#[\da-f]{6}$/i);
  } finally {
    await page.goto("/profile");
    const toggle = page.getByRole("switch", { name: "Match album art" });
    if (((await toggle.getAttribute("aria-checked")) === "true") !== wasMatching) await toggle.click();
  }
});
