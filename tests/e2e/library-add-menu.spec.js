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

const aurralButton = (page) =>
  page.locator(".artist-action-bar").getByRole("button", { name: /^Aurral monitoring/ });
const lidarrAddButton = (page) =>
  page.locator(".artist-action-bar").getByRole("button", { name: "Add to Lidarr", exact: true });

async function chooseAurralFromCard(page, label) {
  const trigger = page.getByRole("menuitem", { name: "Monitor with Aurral", exact: true });
  const submenu = page.locator(".artist-menu-submenu").filter({ has: trigger });
  await trigger.click();
  await submenu.locator(".artist-menu-submenu__panel").getByRole("menuitem", { name: label, exact: true }).click();
}

async function fixture(page, { configured = true, defaultOwner = "lidarr", add, albumAdd, health, existingAfterAdd, albumOwner, releases = [] } = {}) {
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
    if (path === "/users/me/library-owner") {
      if (request.method() !== "GET") writes.push({ path, body: request.postDataJSON() });
      return json({ defaultLibraryOwner: defaultOwner, storedDefaultLibraryOwner: defaultOwner });
    }
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
      return json({
        aurral: { inLibrary: false, mode: "none" },
        lidarr: { available: configured !== false, inLidarr: false, monitorOption: "none", error: null },
        active: null,
      });
    }
    if (path === `/library/artists/${artist.id}` && request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      return json({ managedBy: body.manager, monitored: body.monitorOption !== "none", monitorOption: body.monitorOption });
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

test("disconnected artists offer Aurral monitoring alone even with a stale Lidarr default", async ({ page }) => {
  const writes = await fixture(page, { configured: false, defaultOwner: "lidarr" });
  await page.goto(`/artist/${artist.id}`);
  await expect(aurralButton(page)).toHaveAccessibleName("Aurral monitoring: Unmonitored");
  await expect(lidarrAddButton(page)).toHaveCount(0);
  await aurralButton(page).click();
  expect(writes).toEqual([]);
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: "/library/artists", body: { managedBy: "aurral", monitorOption: "all" } });
});

test("customization is available with Aurral default and cancel writes nothing", async ({ page }) => {
  const writes = await fixture(page, { defaultOwner: "aurral" });
  await page.goto(`/artist/${artist.id}`);
  const trigger = lidarrAddButton(page);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Customize Lidarr add…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Customize Lidarr add", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to Lidarr", exact: true })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
});

test("customized Lidarr failure keeps the dialog available and never falls back to Aurral", async ({ page }) => {
  const writes = await fixture(page, { defaultOwner: "aurral" });
  await page.goto(`/artist/${artist.id}`);
  await lidarrAddButton(page).click();
  await page.getByRole("menuitem", { name: "Customize Lidarr add…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Customize Lidarr add", exact: true });
  await expect(dialog.getByRole("button", { name: "Add to Lidarr", exact: true })).toBeEnabled();
  await dialog.getByRole("combobox").nth(1).selectOption("/fixture-music");
  await dialog.getByRole("button", { name: "Add to Lidarr", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Failed to add.*Lidarr/ })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to Lidarr", exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ managedBy: "lidarr", rootFolderPath: "/fixture-music" });
});

test("pending Lidarr add prevents duplicate submissions and failure allows a retry", async ({ page }) => {
  let finishAdd;
  const gate = new Promise((resolve) => { finishAdd = resolve; });
  let submissions = 0;
  const writes = await fixture(page, { defaultOwner: "aurral", add: async (route) => {
    submissions += 1;
    if (submissions === 1) await gate;
    return route.fulfill({ status: 503, json: { error: "Fixture service unavailable" } });
  } });
  await page.goto(`/artist/${artist.id}`);
  const trigger = lidarrAddButton(page);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Add without monitoring", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(trigger).toBeDisabled();
  expect(writes[0].body).toMatchObject({ managedBy: "lidarr", monitorOption: "none" });
  finishAdd();
  await expect(page.getByText("Fixture service unavailable")).toBeVisible();
  await expect(trigger).toBeEnabled();
  expect(writes).toHaveLength(1);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Add without monitoring", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ body }) => body.managedBy)).toEqual(["lidarr", "lidarr"]);
});

test("unknown configuration prevents a guessed add and health retry recovers", async ({ page }) => {
  let recover = false;
  const writes = await fixture(page, { configured: null, health: (route) => route.fulfill({
    status: recover ? 200 : 503,
    json: recover ? { lidarrConfigured: true } : { error: "Health unavailable" },
  }) });
  await page.goto(`/artist/${artist.id}`);
  const actionBar = page.locator(".artist-action-bar");
  const retry = actionBar.getByRole("button", { name: "Retry library destinations", exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  expect(writes).toEqual([]);
  recover = true;
  await retry.click();
  await lidarrAddButton(page).click();
  await expect(page.getByRole("menuitem", { name: "Add without monitoring", exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

for (const surface of ["discover", "search", "similar"]) {
  test(`${surface} artist options list both managers' choices and submit the selected one`, async ({ page }) => {
    const writes = await fixture(page, { defaultOwner: "lidarr" });
    const url = surface === "similar" ? `/artist/${artist.id}` : surface === "search" ? "/search?q=Menu&type=artist" : "/discover";
    await page.goto(url);
    const name = surface === "similar" ? "Similar Menu Artist" : artist.name;
    await page.getByRole("button", { name: `Artist options for ${name}`, exact: true }).click();
    const initialUrl = page.url();
    await expect(page.getByRole("menuitem", { name: "Add to Lidarr", exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await chooseAurralFromCard(page, "All albums");
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toMatchObject({ managedBy: "aurral", monitorOption: "all" });
    await expect(page).toHaveURL(initialUrl);
  });
}

test("search result artists offer each manager's monitoring choices", async ({ page }) => {
  const writes = await fixture(page, { defaultOwner: "lidarr" });
  const top = { ...artist, type: "artist" };
  const second = { ...artist, id: "second-menu-artist", name: "Second Menu Artist", type: "artist" };
  await page.route("**/api/search/unified**", (route) =>
    route.fulfill({ json: { top, catalog: { artists: [top, second], albums: [], tracks: [] } } }));
  await page.goto("/search?q=Menu");
  await page.getByRole("button", { name: "Add to…", exact: true }).first().click();
  await expect(page.getByRole("menuitem", { name: "Add to Lidarr", exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await chooseAurralFromCard(page, "Latest album");
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ managedBy: "aurral", monitorOption: "latest" });
});

test("disconnected Discover names Aurral and omits Lidarr", async ({ page }) => {
  const writes = await fixture(page, { configured: false });
  await page.goto("/discover");
  await page.getByRole("button", { name: `Artist options for ${artist.name}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Add to Lidarr", exact: true })).toHaveCount(0);
  await chooseAurralFromCard(page, "All albums");
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ managedBy: "aurral", monitorOption: "all" });
});

for (const outcome of ["success", "conflict"]) {
test(`a similar-artist ${outcome} removes the add choices`, async ({ page }) => {
  const writes = await fixture(page, { add: (route, body) => route.fulfill({
    status: outcome === "conflict" ? 409 : 200,
    json: outcome === "conflict"
      ? { code: "artist_owner_conflict", managedBy: "lidarr", error: "Already managed by Lidarr" }
      : { id: body.foreignArtistId, managedBy: body.managedBy },
  }) });
  await page.goto(`/artist/${artist.id}`);
  const trigger = page.getByRole("button", { name: "Artist options for Similar Menu Artist", exact: true });
  await trigger.click();
  await chooseAurralFromCard(page, "All albums");
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: /^(Add to|Monitor with) / })).toHaveCount(0);
});
}

for (const view of ["cards", "list"]) {
  test(`artist release ${view} add selection does not navigate the card`, async ({ page }) => {
    const writes = await fixture(page, { releases: [release], defaultOwner: "aurral" });
    const url = view === "list" ? `/artist/${artist.id}/albums` : `/artist/${artist.id}`;
    await page.goto(url);
    if (view === "list") await page.getByRole("button", { name: "Switch to list view", exact: true }).click();
    const card = page.locator(view === "list" ? ".artist-release-list-item" : ".artist-release-card").filter({ hasText: release.title });
    await card.getByRole("button", { name: "Add to…", exact: true }).click();
    expect(writes).toEqual([]);
    await page.getByRole("menuitem", { name: "Add to Aurral", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body.managedBy).toBe("aurral");
    await expect(page).toHaveURL(new RegExp(`${url}$`));
  });
}

test("new release has one destination menu without artist customization", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto(`/artist/${artist.id}/release/${release.id}`);
  await page.getByRole("button", { name: "Add to…", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Add to…" });
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  expect(writes).toEqual([]);
  await menu.getByRole("menuitem", { name: "Add to Lidarr", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: "/library/albums/request", body: { managedBy: "lidarr", albumMbid: release.id } });
  await expect(page.getByRole("alert").filter({ hasText: /Failed to add album to Lidarr/ })).toBeVisible();
});

test("owned album search keeps Aurral owner instead of opening the add menu", async ({ page }) => {
  const writes = await fixture(page, { albumOwner: "aurral", defaultOwner: "lidarr" });
  await page.goto(`/artist/${artist.id}/release/${release.id}`);
  await page.getByRole("button", { name: "Search Album", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ managedBy: "aurral", triggerSearch: true });
});

for (const defaultOwner of ["lidarr", "aurral"]) {
  test(`artist buttons put the ${defaultOwner} default first without writing`, async ({ page }) => {
    const writes = await fixture(page, { defaultOwner });
    await page.goto(`/artist/${artist.id}`);
    await expect(page.getByRole("heading", { level: 1, name: artist.name })).toBeVisible();
    const buttons = page.locator(".artist-action-bar .artist-monitoring-buttons").getByRole("button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveAccessibleName(
      defaultOwner === "lidarr" ? "Add to Lidarr" : "Aurral monitoring: Unmonitored",
    );
    const trigger = buttons.nth(0);
    await trigger.click();
    expect(writes).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}


test("a Search album retains its selected owner for subsequent searches", async ({ page }) => {
  const writes = await fixture(page, { defaultOwner: "lidarr", albumAdd: (route) => route.fulfill({
    json: { album: { id: 42 }, status: "monitored" },
  }) });
  await page.goto("/search?q=Menu&type=album");
  await page.getByRole("button", { name: "Add to…", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to Aurral", exact: true }).click();
  await expect(page.getByRole("button", { name: "Search Album", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Search Album", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ body }) => body.managedBy)).toEqual(["aurral", "aurral"]);
  expect(writes[1].body.triggerSearch).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
});


test("a refused Lidarr add explains why and leaves both buttons usable", async ({ page }) => {
  const writes = await fixture(page, {
    add: (route) => route.fulfill({ status: 409, json: {
      code: "artist_owner_conflict", managedBy: "aurral", error: "Already managed by Aurral",
    } }),
  });
  await page.goto(`/artist/${artist.id}`);
  await lidarrAddButton(page).click();
  await page.getByRole("menuitem", { name: "Add without monitoring", exact: true }).click();
  await expect(page.getByText("Already managed by Aurral")).toBeVisible();
  await expect(lidarrAddButton(page)).toBeEnabled();
  await expect(aurralButton(page)).toBeEnabled();
  expect(writes).toHaveLength(1);
});


test.describe("touch add controls", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("the plus has a touch target and its menu fits the viewport", async ({ page }) => {
    const writes = await fixture(page);
    await page.goto(`/artist/${artist.id}`);
    const trigger = lidarrAddButton(page);
    const target = await trigger.boundingBox();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await trigger.tap();
    const menu = page.getByRole("menu", { name: "Add to Lidarr" });
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const box = await menu.boundingBox();
      return box.y + box.height;
    }).toBeLessThanOrEqual(844);
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    expect(writes).toEqual([]);
  });
});


test("release success keeps its selected owner for the next search", async ({ page }) => {
  const writes = await fixture(page, { defaultOwner: "lidarr", albumAdd: (route) => route.fulfill({
    json: { album: { id: 42, monitored: true }, managedBy: "aurral", status: "monitored" },
  }) });
  await page.goto(`/artist/${artist.id}/release/${release.id}`);
  await page.getByRole("button", { name: "Add to…", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to Aurral", exact: true }).click();
  const search = page.getByRole("button", { name: "Search Album", exact: true });
  await expect(search).toBeEnabled();
  await search.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ body }) => body.managedBy)).toEqual(["aurral", "aurral"]);
});


test("returning to an artist refreshes configuration despite connected bootstrap data", async ({ page }) => {
  await page.clock.install();
  let configured = true;
  const writes = await fixture(page, { health: (route) => route.fulfill({ json: { lidarrConfigured: configured } }) });
  await page.goto(`/artist/${artist.id}`);
  const actionBar = page.locator(".artist-action-bar");
  await lidarrAddButton(page).click();
  await expect(page.getByRole("menuitem", { name: "Add without monitoring", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('a[href="/library"]').first().click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(actionBar).toHaveCount(0);
  configured = false;
  await page.clock.fastForward(31_000);
  await page.goBack();
  await expect(aurralButton(page)).toBeEnabled();
  await expect(lidarrAddButton(page)).toHaveCount(0);
  expect(writes).toEqual([]);
  await aurralButton(page).click();
  await page.getByRole("menuitemradio", { name: "All albums", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: "/library/artists", body: { managedBy: "aurral", monitorOption: "all" } });
});
