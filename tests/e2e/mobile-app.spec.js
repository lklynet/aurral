import { devices, expect, test } from "@playwright/test";

const { defaultBrowserType: _defaultBrowserType, ...iPhone } = devices["iPhone 13"];
test.use(iPhone);

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

const disposableArtist = { mbid: "f22942a1-6f70-4f48-866e-238cb2308fbd", name: "Aphex Twin" };
const release = {
  artistMbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  mbid: "b1392450-e666-3926-a536-22c65f834433",
  artistName: "Radiohead",
};

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

async function openApp(page) {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
}

async function apiRequest(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const token = localStorage.getItem("auth_token");
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: {
        ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      credentials: "include",
      cache: "no-store",
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  }, { requestPath: path, requestMethod: method, requestBody: body });
}

function pageMetrics(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    smallTextFields: [...document.querySelectorAll("input, select, textarea")]
      .filter((field) => !["checkbox", "radio", "range", "hidden"].includes(field.type))
      .filter((field) => field.getClientRects().length > 0)
      .filter((field) => parseFloat(getComputedStyle(field).fontSize) < 16)
      .map((field) => field.getAttribute("aria-label") || field.name || field.tagName),
  }));
}

test("the shell stays fixed, avoids input zoom, and reaches every section", async ({ page }) => {
  await openApp(page);

  for (const path of ["/", "/library", "/activity/queue", `/artist/${release.artistMbid}`, "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    const metrics = await pageMetrics(page);
    expect(metrics.documentWidth, `${path} scrolls sideways`).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.documentHeight, `${path} scrolls the page body`).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.smallTextFields, `${path} has fields that zoom on focus`).toEqual([]);
  }

  const tabs = page.getByRole("navigation", { name: "Mobile navigation" });
  await tabs.getByRole("link", { name: "Library" }).tap();
  await expect(page).toHaveURL(/\/library$/);
  await page.getByRole("navigation", { name: "Library views" }).getByRole("link", { name: "Tracks" }).tap();
  await expect(page).toHaveURL(/\/library\/tracks$/);
  await expect(
    page.getByRole("navigation", { name: "Library views" }).getByRole("link", { name: "Tracks" }),
  ).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("button", { name: "More navigation options" }).tap();
  const more = page.getByRole("dialog", { name: "More navigation options" });
  await expect(more).toBeVisible();
  await more.getByRole("link", { name: "Settings" }).tap();
  await expect(page).toHaveURL(/\/settings/);
  await expect(more).toHaveCount(0);
  await expect(tabs.getByRole("button", { name: "More navigation options" })).toHaveClass(/is-active/);
});

test("search results open an artist and the back control returns to them", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);

  const search = page.getByRole("textbox", { name: "Search music, artists, or tags" });
  await search.tap();
  await search.fill(release.artistName);
  await search.press("Enter");
  await expect(page).toHaveURL(/\/search\?/);
  await page
    .getByRole("button", { name: `Open ${release.artistName}`, exact: true })
    .first()
    .tap({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/artist\//);
  await page.getByRole("button", { name: "Go back" }).tap();
  await expect(page).toHaveURL(/\/search\?/);
});

test("a release opened from a direct link names its artist", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.goto(`/artist/${release.artistMbid}/release/${release.mbid}`);
  await expect(page.getByRole("main").getByRole("link", { name: release.artistName, exact: true }))
    .toBeVisible({ timeout: 30_000 });
});

test("library playback moves between the mini player and the now playing sheet", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.goto("/library/tracks");
  const titles = page.locator(".native-library-track__title");
  await expect(titles.first(), "Eden's playback fixture is missing from the library").toBeVisible({
    timeout: 30_000,
  });
  expect(await titles.count(), "the playback fixture needs at least two tracks").toBeGreaterThan(1);

  await titles.first().tap();
  const openNowPlaying = page.getByRole("button", { name: /^Open now playing: / });
  await expect(openNowPlaying).toBeVisible();
  const firstTitle = (await openNowPlaying.getAttribute("aria-label")).replace("Open now playing: ", "");

  await openNowPlaying.tap();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing" });
  await expect(nowPlaying.getByRole("heading", { name: firstTitle })).toBeVisible();
  await nowPlaying.getByRole("button", { name: "Next track" }).tap();
  await expect(nowPlaying.getByRole("heading", { level: 2 })).not.toHaveText(firstTitle);

  await nowPlaying.getByRole("button", { name: "Close now playing" }).tap();
  await expect(nowPlaying).toHaveCount(0);
  await expect(openNowPlaying).toBeVisible();

  await openNowPlaying.tap();
  await page.getByRole("dialog", { name: "Now playing" }).getByRole("button", { name: "Stop and clear queue" }).tap();
  await expect(openNowPlaying).toHaveCount(0);
});

test("item menus open as bottom sheets and a tap outside only closes them", async ({ page }) => {
  await openApp(page);
  await page.goto("/library/tracks");
  const firstTitle = page.locator(".native-library-track__title > span").first();
  await expect(firstTitle).toBeVisible({ timeout: 30_000 });
  const trackName = await firstTitle.textContent();

  await page.getByRole("button", { name: `${trackName} options` }).tap();
  const menu = page.getByRole("menu", { name: `${trackName} actions` });
  await expect(menu).toBeVisible();
  const viewport = page.viewportSize();
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return [Math.round(box.y + box.height), Math.round(box.width)];
    })
    .toEqual([viewport.height, viewport.width]);

  await menu.getByRole("menuitem", { name: "Add to playlist" }).tap();
  await expect(menu.getByRole("button", { name: "New playlist" })).toBeVisible();

  await page.mouse.click(viewport.width / 2, viewport.height * 0.35);
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/library\/tracks$/);
});

test("an artist is added to the library from its page", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const existing = await apiRequest(page, `/api/library/artists/${disposableArtist.mbid}`);
  expect(existing.status, `${disposableArtist.name} must not already be in the candidate library`).toBe(404);

  try {
    await page.goto(`/artist/${disposableArtist.mbid}`);
    await expect(page.getByRole("heading", { name: disposableArtist.name, level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    await page.locator(".artist-action-bar").getByRole("button", { name: "Add to…" }).tap();
    await page.getByRole("menuitem", { name: "Add to Aurral" }).tap();
    await expect(page.locator(".artist-action-bar").getByRole("button", { name: /In library/i })).toBeVisible({
      timeout: 60_000,
    });
    await apiRequest(page, `/api/library/artists/${disposableArtist.mbid}`, {
      method: "PUT",
      body: { monitored: false, monitorOption: "none" },
    });
    const added = await apiRequest(page, `/api/library/artists/${disposableArtist.mbid}`);
    expect(added.body?.managedBy).toBe("aurral");
  } finally {
    const leftover = await apiRequest(page, `/api/library/artists/${disposableArtist.mbid}`);
    if (leftover.status !== 404 && leftover.body?.managedBy === "aurral") {
      await apiRequest(page, `/api/library/artists/${disposableArtist.mbid}?deleteFiles=true`, {
        method: "DELETE",
      });
    }
  }
});
