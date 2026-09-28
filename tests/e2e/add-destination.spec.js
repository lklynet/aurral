import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

const lidarrArtist = { mbid: "69158f97-4c07-4c4e-baf8-4e4ab1ed666e", name: "Boards of Canada" };
const aurralArtist = { mbid: "f22942a1-6f70-4f48-866e-238cb2308fbd", name: "Aphex Twin" };

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

async function signIn(page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

const lookupArtist = async (page, mbid) =>
  (await apiRequest(page, `/api/library/lookup/${mbid}`)).body;

async function tabTo(page, locator) {
  for (let step = 0; step < 120; step += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard focus never reached the Add to… menu");
}

test("a connected user adds to Lidarr, then adds to Aurral from the keyboard", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);

  const ownerBefore = await apiRequest(page, "/api/users/me/library-owner");
  expect(ownerBefore.body).toEqual({ defaultLibraryOwner: "lidarr", storedDefaultLibraryOwner: null });
  for (const artist of [lidarrArtist, aurralArtist]) {
    expect(
      (await apiRequest(page, `/api/library/artists/${artist.mbid}`)).status,
      `${artist.name} must start outside the library; use a fresh candidate database`,
    ).toBe(404);
  }

  try {
    await page.goto(`/artist/${lidarrArtist.mbid}`);
    await expect(page.getByRole("heading", { name: lidarrArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.locator(".artist-action-bar").getByRole("button", { name: "Add to Lidarr", exact: true }).click();
    await expect(page.getByRole("button", { name: /In Library/ })).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 }).toBe(true);
    const lidarrRecord = await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}`);
    expect(lidarrRecord.status).toBe(200);
    expect(lidarrRecord.body?.managedBy).not.toBe("aurral");

    await page.goto(`/artist/${aurralArtist.mbid}`);
    await expect(page.getByRole("heading", { name: aurralArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const menuTrigger = page.locator(".artist-action-bar").getByRole("button", { name: "Add to…", exact: true });
    await expect(menuTrigger).toBeVisible({ timeout: 30_000 });
    await expect(menuTrigger).toBeEnabled();
    await expect(menuTrigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "false");

    await page.locator("body").focus();
    await tabTo(page, menuTrigger);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Add to…" });
    const aurralItem = menu.getByRole("menuitem", { name: "Add to Aurral" });
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(aurralItem).toBeFocused();
    await expect(menu.getByRole("menuitem")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(menuTrigger).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(aurralItem).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /In Library/ })).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => (await apiRequest(page, `/api/library/artists/${aurralArtist.mbid}`)).body?.managedBy, {
        timeout: 15_000,
      })
      .toBe("aurral");
    const ownerAfter = await apiRequest(page, "/api/users/me/library-owner");
    expect(ownerAfter.body).toEqual(ownerBefore.body);
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
