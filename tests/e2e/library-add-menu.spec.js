import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = {
  id: "library-menu-artist",
  name: "Menu Test Artist",
  "release-groups": [],
  "appears-on-release-groups": [],
  tags: [],
  genres: [],
};
const release = { id: "library-menu-album", title: "Menu Test Album", "primary-type": "Album" };

const monitorButton = (page) =>
  page.locator(".artist-action-bar").getByRole("button", { name: /^(Monitor|Monitoring: .*)$/ });

async function openCustomize(page) {
  await monitorButton(page).click();
  await page.getByRole("menuitem", { name: "Customize add…", exact: true }).click();
  return page.getByRole("dialog", { name: "Customize Lidarr add", exact: true });
}

async function fixture(page, { configured = true, add, update, albumAdd, health, monitoring, existingAfterAdd, albumOwner, releases = [] } = {}) {
  const writes = [];
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, ...(configured === null ? {} : { lidarrConfigured: configured }) });
    }
    if (path === "/health") return health ? health(route) : json({ lidarrConfigured: configured });
    if (path === `/artists/${artist.id}/stream`) {
      const events = {
        artist: { ...artist, "release-groups": releases },
        cover: { images: [] },
        similar: { artists: [{ id: "similar-menu-artist", name: "Similar Menu Artist" }] },
        library: { exists: false },
        complete: {},
      };
      return route.fulfill({ contentType: "text/event-stream", body: Object.entries(events)
        .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("") });
    }
    if (path === "/library/artists" && request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (add) return add(route, body);
      return json({ error: "Fixture service unavailable" }, 503);
    }
    if (path === "/library/albums/request") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (albumAdd) return albumAdd(route, body);
      return json({ error: "Fixture service unavailable" }, 503);
    }
    if (path === "/users/me/lidarr-preferences") {
      return json({ configured, rootFolders: [{ path: "/fixture-music" }],
        qualityProfiles: [{ id: 1, name: "Fixture quality" }], tags: [] });
    }
    if (path === "/library/lookup/batch") {
      return json(Object.fromEntries(request.postDataJSON().mbids.map((id) => [id, false])));
    }
    if (path.startsWith("/library/lookup/")) return json(existingAfterAdd && writes.length
      ? { exists: true, artist: existingAfterAdd } : { exists: false });
    if (path === `/library/artists/${artist.id}/monitoring`) {
      return json(monitoring?.() ?? {
        manager: configured === false ? "aurral" : "lidarr", added: false, monitorOption: "none", error: null,
      });
    }
    if (path === `/library/artists/${artist.id}` && request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (update) return update(route, body);
      return json({ monitored: body.monitorOption !== "none", monitorOption: body.monitorOption });
    }
    if (path === `/library/artists/${artist.id}`) return json(existingAfterAdd || {});
    if (path === "/library/albums/lookup/batch") {
      return json({ [release.id]: albumOwner ? { inLibrary: true, monitored: true,
        managedBy: albumOwner, libraryAlbumId: 42, trackCount: 1, trackFileCount: 0 } : { inLibrary: false } });
    }
    if (path === `/artists/release-group/${release.id}`) return json(release);
    if (path === "/discover") return json({ recommendations: [artist], configured: true });
    if (path === "/search") return json({ items: new URL(request.url()).searchParams.get("type") === "album"
      ? [{ ...release, type: "album", artistMbid: artist.id, artistName: artist.name }] : [artist], count: 1, hasMore: false });
    if (path.endsWith("/cover")) return json({ images: [] });
    if (path === "/artists/release-groups/covers") return json({});
    if (path === "/users/me/discover-layout") return json({ layout: [] });
    if (path === "/settings") return json({});
    if (path === "/discover/feedback") return json({ feedback: [] });
    if (path === "/library/favorites") return json({});
    return json([]);
  });
  return writes;
}

const monitoringPath = `/library/artists/${artist.id}`;

test("without Lidarr, Monitor offers Aurral's options and monitors the artist", async ({ page }) => {
  const writes = await fixture(page, { configured: false });
  await page.goto(`/artist/${artist.id}`);
  await expect(monitorButton(page)).toHaveAccessibleName("Monitor");
  await monitorButton(page).click();
  await expect(page.getByRole("menuitemradio", { name: "Not monitored", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: "Existing albums", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Customize add…", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: monitoringPath, body: { monitorOption: "all" } });
});

test("with Lidarr, Monitor adds and monitors the artist in one choice", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/artist/${artist.id}`);
  await expect(monitorButton(page)).toHaveAccessibleName("Monitor");
  await monitorButton(page).click();
  await expect(page.getByRole("menuitem", { name: "Customize add…", exact: true })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Existing albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: monitoringPath, body: { monitorOption: "existing" } });
});

test("a monitored artist shows its option and offers no delete on Discover", async ({ page }) => {
  await fixture(page, {
    monitoring: () => ({ manager: "lidarr", added: true, monitorOption: "all", inAurral: true, error: null }),
  });
  await page.goto(`/artist/${artist.id}`);
  await expect(monitorButton(page)).toHaveAccessibleName("Monitoring: All albums");
  await monitorButton(page).click();
  await expect(page.getByRole("menuitemradio", { name: "All albums", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitem", { name: /Customize|Remove|Delete/ })).toHaveCount(0);
});

test("customization opens from the Monitor menu and cancel writes nothing", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/artist/${artist.id}`);
  const dialog = await openCustomize(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to Lidarr", exact: true })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("customized Lidarr failure keeps the dialog available and never falls back to Aurral", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/artist/${artist.id}`);
  const dialog = await openCustomize(page);
  await expect(dialog.getByRole("button", { name: "Add to Lidarr", exact: true })).toBeEnabled();
  await dialog.getByRole("combobox").nth(1).selectOption("/fixture-music");
  await dialog.getByRole("button", { name: "Add to Lidarr", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Could not add the artist/ })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ managedBy: "lidarr", rootFolderPath: "/fixture-music" });
});

test("a pending change prevents duplicates and a failure allows a retry", async ({ page }) => {
  let finishUpdate;
  const gate = new Promise((resolve) => { finishUpdate = resolve; });
  let submissions = 0;
  const writes = await fixture(page, { update: async (route) => {
    submissions += 1;
    if (submissions === 1) await gate;
    return route.fulfill({ status: 503, json: { error: "Fixture service unavailable" } });
  } });
  await page.goto(`/artist/${artist.id}`);
  await monitorButton(page).click();
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(monitorButton(page)).toBeDisabled();
  finishUpdate();
  await expect(page.getByText("Fixture service unavailable")).toBeVisible();
  await expect(monitorButton(page)).toBeEnabled();
  await monitorButton(page).click();
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
});

test("unknown configuration prevents a guessed change and health retry recovers", async ({ page }) => {
  let recover = false;
  const writes = await fixture(page, { configured: null, health: (route) => route.fulfill({
    status: recover ? 200 : 503,
    json: recover ? { lidarrConfigured: true } : { error: "Health unavailable" },
  }) });
  await page.goto(`/artist/${artist.id}`);
  const retry = page.locator(".artist-action-bar").getByRole("button", { name: "Retry library destinations", exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  recover = true;
  await retry.click();
  await expect(monitorButton(page)).toBeEnabled();
  expect(writes).toEqual([]);
});

for (const surface of ["discover", "search", "similar"]) {
  test(`${surface} artist cards leave adding to the artist page`, async ({ page }) => {
    const writes = await fixture(page);
    const url = surface === "similar" ? `/artist/${artist.id}` : surface === "search" ? "/search?q=Menu&type=artist" : "/discover";
    await page.goto(url);
    const name = surface === "similar" ? "Similar Menu Artist" : artist.name;
    await page.getByRole("button", { name: `Artist options for ${name}`, exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "More like this", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^(Add to|Monitor with) / })).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("search results have no artist add button", async ({ page }) => {
  await fixture(page);
  const top = { ...artist, type: "artist" };
  await page.route("**/api/search/unified**", (route) =>
    route.fulfill({ json: { top, catalog: { artists: [top], albums: [], tracks: [] } } }));
  await page.goto("/search?q=Menu");
  await expect(page.getByRole("button", { name: `Open ${artist.name}`, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Add to|Monitor with) / })).toHaveCount(0);
});

for (const view of ["cards", "list"]) {
  test(`artist release ${view} download goes to the active manager without navigating`, async ({ page }) => {
    const writes = await fixture(page, { releases: [release] });
    const url = view === "list" ? `/artist/${artist.id}/albums` : `/artist/${artist.id}`;
    await page.goto(url);
    if (view === "list") await page.getByRole("button", { name: "Switch to list view", exact: true }).click();
    const card = page.locator(view === "list" ? ".artist-release-list-item" : ".artist-release-card").filter({ hasText: release.title });
    await card.getByRole("button", { name: "Download album", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body.managedBy).toBe("lidarr");
    await expect(page).toHaveURL(new RegExp(`${url}$`));
  });
}

test("a new release downloads in one click and reports a failure without naming a manager", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/artist/${artist.id}/release/${release.id}`);
  await page.getByRole("button", { name: "Download album", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: "/library/albums/request", body: { managedBy: "lidarr", albumMbid: release.id } });
  await expect(page.getByRole("alert").filter({ hasText: "Could not download the album" })).toBeVisible();
});

test("with Lidarr connected, downloading an album Aurral monitors goes to Lidarr", async ({ page }) => {
  const writes = await fixture(page, { albumOwner: "aurral" });
  await page.goto(`/artist/${artist.id}/release/${release.id}`);
  await page.getByRole("button", { name: "Download album", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ managedBy: "lidarr", triggerSearch: true });
});

test("a refused change explains why and leaves the button usable", async ({ page }) => {
  const writes = await fixture(page, {
    update: (route) => route.fulfill({ status: 409, json: { error: "Lidarr refused the artist" } }),
  });
  await page.goto(`/artist/${artist.id}`);
  await monitorButton(page).click();
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect(page.getByText("Lidarr refused the artist")).toBeVisible();
  await expect(monitorButton(page)).toBeEnabled();
  expect(writes).toHaveLength(1);
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("the Monitor button is a touch target and its menu fits the viewport", async ({ page }) => {
    const writes = await fixture(page);
    await page.goto(`/artist/${artist.id}`);
    const trigger = monitorButton(page);
    const target = await trigger.boundingBox();
    expect(target.height).toBeGreaterThanOrEqual(44);
    await trigger.tap();
    const menu = page.getByRole("menu", { name: "Monitoring" });
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const box = await menu.boundingBox();
      return box.y + box.height;
    }).toBeLessThanOrEqual(844);
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    expect(writes).toEqual([]);
  });
});

test("returning to an artist after Lidarr is disconnected drops the Lidarr-only choices", async ({ page }) => {
  await page.clock.install();
  let configured = true;
  const writes = await fixture(page, {
    health: (route) => route.fulfill({ json: { lidarrConfigured: configured } }),
    monitoring: () => ({ manager: configured ? "lidarr" : "aurral", added: false, monitorOption: "none", error: null }),
  });
  await page.goto(`/artist/${artist.id}`);
  const actionBar = page.locator(".artist-action-bar");
  await expect(monitorButton(page)).toBeVisible();
  await page.locator('a[href="/library"]').first().click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(actionBar).toHaveCount(0);
  configured = false;
  await page.clock.fastForward(31_000);
  await page.goBack();
  await monitorButton(page).click();
  await expect(page.getByRole("menuitemradio", { name: "Existing albums", exact: true })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: monitoringPath, body: { monitorOption: "all" } });
});
