import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = { id: "nav-link-artist", name: "Link Test Artist", tags: [], genres: [] };
const playlist = { id: "908622995", name: "Link Test Mix", trackCount: 2, artworkUrl: null };
const playlistPath = `/discover/playlists/deezer/${playlist.id}`;
const trackTitle = (page, title) =>
  page.getByRole("list", { name: `${playlist.name} tracks` }).getByText(title, { exact: true });

async function fixture(page, { holdPlaylist } = {}) {
  const requests = [];
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    requests.push(path);
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (path === "/health") return json({ lidarrConfigured: true });
    if (path === "/discover") return json({ recommendations: [artist], configured: true });
    if (path === "/discover/editorial") return json({ forYou: [playlist], genres: [] });
    if (path === `/discover/editorial/${playlist.id}`) {
      await holdPlaylist;
      return json({
        ...playlist,
        tracks: [
          { trackName: "First Link Track", artistName: artist.name, albumName: "Link Album" },
          { trackName: "Second Link Track", artistName: artist.name, albumName: "Link Album" },
        ],
      });
    }
    if (path === "/discover/editorial/links") return json({ artistMbid: artist.id, albumMbid: null });
    if (path === `/artists/${artist.id}/stream`) {
      const events = { artist: { ...artist, "release-groups": [] }, cover: { images: [] }, library: { exists: false }, complete: {} };
      return route.fulfill({
        contentType: "text/event-stream",
        body: Object.entries(events).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      });
    }
    if (path === "/library/lookup/batch") {
      return json(Object.fromEntries((request.postDataJSON()?.mbids || []).map((id) => [id, false])));
    }
    if (path.endsWith("/cover")) return json({ images: [] });
    if (path === "/artists/release-groups/covers") return json({});
    if (path === "/users/me/discover-layout") return json({ layout: [] });
    if (path === "/settings") return json({});
    if (path === "/discover/feedback") return json({ feedback: [] });
    if (path === "/library/favorites") return json({});
    return json([]);
  });
  return requests;
}

test("Discover cards are real links with separate controls", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const main = page.locator("main");

  const playlistLink = main.getByRole("link", { name: `Open ${playlist.name}`, exact: true });
  await expect(playlistLink).toHaveAttribute("href", playlistPath);
  const artistLink = main.getByRole("link", { name: `Open ${artist.name}`, exact: true }).first();
  await expect(artistLink).toHaveAttribute("href", `/artist/${artist.id}`);

  const nested = await main
    .locator(
      ":is(a, button, [role=button]) :is(a, button, [role=button], input, select, textarea)",
    )
    .count();
  expect(nested).toBe(0);
});

test("modifier-clicking a card opens a new tab and leaves the page in place", async ({ page, context }) => {
  await fixture(page);
  await page.goto("/");
  const playlistLink = page.locator("main").getByRole("link", { name: `Open ${playlist.name}`, exact: true });
  await expect(playlistLink).toBeVisible();

  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    playlistLink.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }),
  ]);
  await opened.waitForLoadState("domcontentloaded");
  expect(new URL(opened.url()).pathname).toBe(playlistPath);
  await opened.close();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a plain click on a card opens the playlist in place", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await page.locator("main").getByRole("link", { name: `Open ${playlist.name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${playlistPath}$`));
  await expect(page.getByRole("heading", { name: playlist.name })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("hovering a card prefetches its page and the click reuses it", async ({ page }) => {
  const requests = await fixture(page);
  await page.goto("/");
  const playlistLink = page.locator("main").getByRole("link", { name: `Open ${playlist.name}`, exact: true });
  await expect(playlistLink).toBeVisible();
  const detailRequests = () => requests.filter((path) => path === `/discover/editorial/${playlist.id}`).length;

  await playlistLink.hover();
  await expect.poll(detailRequests).toBe(1);
  await playlistLink.click();
  await expect(page.getByRole("heading", { name: playlist.name })).toBeVisible();
  expect(detailRequests()).toBe(1);
});

test("a playlist opened from its card shows its header before the tracks load", async ({ page }) => {
  let release;
  await fixture(page, { holdPlaylist: new Promise((resolve) => { release = resolve; }) });
  await page.goto("/");
  await page.locator("main").getByRole("link", { name: `Open ${playlist.name}`, exact: true }).click();

  await expect(page.getByRole("heading", { name: playlist.name, level: 1 })).toBeVisible();
  await expect(page.getByText(`${playlist.trackCount} tracks`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Play ${playlist.name} previews` })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Loading tracks" })).toHaveCount(1);
  await expect(trackTitle(page, "First Link Track")).toHaveCount(0);

  release();
  await expect(trackTitle(page, "First Link Track")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading tracks" })).toHaveCount(0);
});

test("a playlist opened directly still loads without card data", async ({ page }) => {
  await fixture(page);
  await page.goto(playlistPath);
  await expect(page.getByRole("heading", { name: playlist.name, level: 1 })).toBeVisible();
  await expect(trackTitle(page, "First Link Track")).toBeVisible();
});

const recordTransitions = () => {
  window.__routeTransitions = [];
  const start = document.startViewTransition?.bind(document);
  if (!start) return;
  document.startViewTransition = (update) => {
    window.__routeTransitions.push(
      [...document.querySelectorAll("[style*=view-transition-name]")].map(
        (node) => node.style.viewTransitionName,
      ),
    );
    return start(update);
  };
};

async function openPlaylistAgain(page) {
  const link = page.locator("main").getByRole("link", { name: `Open ${playlist.name}`, exact: true });
  await link.click();
  await expect(page.getByRole("heading", { name: playlist.name, level: 1 })).toBeVisible();
  await page.goBack();
  await expect(link).toBeVisible();
  await page.evaluate(() => {
    window.__routeTransitions = [];
  });
  await link.click();
  await expect(page.getByRole("heading", { name: playlist.name, level: 1 })).toBeVisible();
}

test("opening a card morphs only that card's artwork into the page header", async ({ page }) => {
  await page.addInitScript(recordTransitions);
  await fixture(page);
  await page.goto("/");
  await openPlaylistAgain(page);
  const transitions = await page.evaluate(() => window.__routeTransitions);
  expect(transitions).toEqual([["shared-artwork"]]);
  await expect(page.locator("[style*=view-transition-name]")).toHaveCount(0);
});

test("route transitions are skipped when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(recordTransitions);
  await fixture(page);
  await page.goto("/");
  await openPlaylistAgain(page);
  expect(await page.evaluate(() => window.__routeTransitions)).toEqual([]);
});

test("track artist names are links that resolve in place without a history entry", async ({ page }) => {
  await fixture(page);
  await page.goto(playlistPath);
  const main = page.locator("main");
  await expect(main.getByText("First Link Track")).toBeVisible();

  const artistLinks = main.getByRole("link", { name: artist.name, exact: true });
  await expect(artistLinks.first()).toHaveAttribute(
    "href",
    `/go/artist?name=${encodeURIComponent(artist.name).replace(/%20/g, "+")}`,
  );
  await expect(main.getByRole("button", { name: artist.name, exact: true })).toHaveCount(0);

  await artistLinks.first().click();
  await expect(page).toHaveURL(new RegExp(`/artist/${artist.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${playlistPath}$`));
});

const settleScroll = async (page, locator) => {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

test("right-clicking a Discover artist card opens its menu in place", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const artistLink = page.locator("main").getByRole("link", { name: `Open ${artist.name}`, exact: true }).first();
  await settleScroll(page, artistLink);
  await artistLink.click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Artist options for ${artist.name}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: /more like this/i })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function touchPath(page, points, holdMs) {
    const cdp = await page.context().newCDPSession(page);
    const [first, ...rest] = points;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
    for (const point of rest) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    }
    await page.waitForTimeout(holdMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  async function artistCardCenter(page) {
    const artistLink = page.locator("main").getByRole("link", { name: `Open ${artist.name}`, exact: true }).first();
    await settleScroll(page, artistLink);
    const box = await artistLink.boundingBox();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  test("a long press on a Discover artist card opens its menu without following the link", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    const point = await artistCardCenter(page);
    await touchPath(page, [point], 800);
    const menu = page.getByRole("menu", { name: `Artist options for ${artist.name}` });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("");
  });

  test("dragging across a Discover artist card does not open its menu", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    const point = await artistCardCenter(page);
    await touchPath(page, [point, { x: point.x, y: point.y + 40 }], 800);
    await expect(page.getByRole("menu", { name: `Artist options for ${artist.name}` })).toHaveCount(0);
  });
});
