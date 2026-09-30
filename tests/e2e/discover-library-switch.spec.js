import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

const linkedMbid = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";

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

async function findUntaggedArtist(page) {
  const response = await apiRequest(page, "/api/library/canonical?kind=artists&pageSize=100");
  expect(response.ok).toBe(true);
  const artist = (response.body?.items || []).find((item) => !item.mbid && item.providerId == null);
  expect(artist, "The candidate library needs an untagged Aurral artist such as the playback fixture").toBeTruthy();
  return artist;
}

test("the view switch moves between the Library and Discover views of one artist", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const artist = await findUntaggedArtist(page);
  const libraryPath = `/library/artist/${encodeURIComponent(artist.id)}`;
  const viewSwitch = page.getByRole("navigation", { name: "View", exact: true });

  await page.goto("/library/artists");
  await page.goto(libraryPath);
  await expect(page.getByRole("heading", { name: artist.name })).toBeVisible();
  await expect(viewSwitch).toHaveCount(0);

  try {
    const linked = await apiRequest(page, `/api/library/canonical/artists/${artist.id}/mbid`, {
      method: "PUT",
      body: { mbid: linkedMbid },
    });
    expect(linked.ok, `Linking the MusicBrainz ID failed with ${linked.status}`).toBe(true);
    expect(linked.body?.merged).toBe(false);

    await page.reload();
    await expect(viewSwitch.getByText("Library")).toHaveAttribute("aria-current", "page");
    await viewSwitch.getByRole("link", { name: "Discover" }).click();

    await expect(page).toHaveURL(new RegExp(`/artist/${linkedMbid}$`));
    await expect(viewSwitch.getByText("Discover")).toHaveAttribute("aria-current", "page", {
      timeout: 30_000,
    });
    await page.screenshot({ path: test.info().outputPath("discover-view.png") });
    await viewSwitch.getByRole("link", { name: "Library" }).click();

    await expect(page).toHaveURL(new RegExp(`${libraryPath}$`));
    await expect(viewSwitch.getByText("Library")).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: test.info().outputPath("library-view.png") });

    await page.goBack();
    await expect(page).toHaveURL(/\/library\/artists$/);
  } finally {
    const restored = await apiRequest(page, `/api/library/canonical/artists/${artist.id}/mbid`, {
      method: "PUT",
      body: { mbid: null },
    });
    expect(restored.ok, `Restoring the untagged artist failed with ${restored.status}`).toBe(true);
  }
});
