import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

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
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, { requestPath: path, requestMethod: method, requestBody: body });
}

test("shared playlist opens from Playlists and its scrobble setting persists", async ({ page }) => {
  await signIn(page);

  const playlistName = `E2E history ${Date.now()}`;
  const createResponse = await apiRequest(page, "/api/playlists/shared-playlists", {
    method: "POST",
    body: { name: playlistName },
  });
  expect(createResponse.ok).toBe(true);
  const playlistId = createResponse.body?.playlistId;
  expect(playlistId).toBeTruthy();

  try {
    await page.goto("/library/playlists");
    const playlistLink = page.getByRole("link", { name: playlistName, exact: true });
    await expect(playlistLink).toBeVisible({ timeout: 15_000 });
    await playlistLink.click();

    await expect(page).toHaveURL(new RegExp(`/library/playlists/${encodeURIComponent(playlistId)}$`));
    await expect(page.getByRole("heading", { name: playlistName, exact: true })).toBeVisible();

    const openMenu = () => page.getByRole("button", { name: `${playlistName} options` }).click();
    const scrobbleOption = page.getByRole("menuitemcheckbox", { name: "Scrobble tracks" });
    await openMenu();
    await expect(scrobbleOption).toHaveAttribute("aria-checked", "true");
    await scrobbleOption.click();
    await expect(page.getByText("Scrobbling turned off")).toBeVisible();

    const statusResponse = await apiRequest(page, "/api/playlists/status");
    expect(statusResponse.ok).toBe(true);
    expect(statusResponse.body.sharedPlaylists.find((playlist) => playlist.id === playlistId).recordHistory).toBe(false);

    await page.reload();
    await openMenu();
    await expect(scrobbleOption).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");

    await page.goBack();
    await expect(page).toHaveURL(/\/library\/playlists$/);
  } finally {
    const deleteResponse = await apiRequest(
      page,
      `/api/playlists/shared-playlists/${encodeURIComponent(playlistId)}`,
      { method: "DELETE" },
    );
    expect([200, 404]).toContain(deleteResponse.status);
    await expect
      .poll(
        async () => {
          const response = await apiRequest(page, "/api/playlists/status");
          return response.body?.sharedPlaylists?.some((playlist) => playlist.id === playlistId) || false;
        },
        { timeout: 15_000 },
      )
      .toBe(false);
  }
});
