import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

const artist = { mbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11", name: "Portishead" };

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

async function openApp(page) {
  await page.goto("/");
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

const ACTIVE_STATUS = /^(queued|downloading)$/;

test("an Aurral artist and album are monitored, unmonitored with a warning, and monitored again", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);

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
    await actionBar.getByRole("button", { name: /In library/ }).click();
    await actionBar.getByRole("button", { name: /^Monitor:/ }).click();

    const optionLabels = ["None (artist only)", "All albums", "Future albums", "Missing albums", "Latest album", "First album"];
    for (const label of optionLabels) {
      await expect(actionBar.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(actionBar.getByRole("button", { name: "Existing albums", exact: true })).toHaveCount(0);

    await actionBar.getByRole("button", { name: "Latest album", exact: true }).click();
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
    const managerMark = page.getByRole("img", { name: /^Managed by Aurral/ });
    const chooseMonitoring = async (label) => {
      await albumOptions.click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await expect(managerMark).toHaveAccessibleName("Managed by Aurral", { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: /Queued|Downloading/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    await chooseMonitoring("Stop monitoring album");
    const dialog = page.getByRole("alertdialog", { name: "Stop monitoring this album?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("unfinished downloads will be cancelled");
    expect(albumMonitoringWrites).toHaveLength(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(managerMark).toHaveAccessibleName("Managed by Aurral");
    expect(albumMonitoringWrites).toHaveLength(0);
    expect((await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status).toMatch(
      ACTIVE_STATUS,
    );

    await chooseMonitoring("Stop monitoring album");
    await dialog.getByRole("button", { name: "Stop monitoring", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Cancelled \d+ downloads?/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(managerMark).toHaveAccessibleName("Managed by Aurral · Not monitored");
    expect(albumMonitoringWrites).toHaveLength(1);
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status, {
        timeout: 30_000,
      })
      .toBe("cancelled");

    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status, {
        timeout: 30_000,
      })
      .toMatch(ACTIVE_STATUS);

    await chooseMonitoring("Monitor album");
    await expect(managerMark).toHaveAccessibleName("Managed by Aurral");
    expect(albumMonitoringWrites).toHaveLength(2);
    await expect
      .poll(async () => (await apiRequest(page, `/api/library/albums/aurral/${albumId}/status`)).body?.status, {
        timeout: 30_000,
      })
      .toMatch(ACTIVE_STATUS);
  } finally {
    if (albumId) {
      await apiRequest(page, `/api/library/albums/aurral/${albumId}/cancel`, { method: "POST" });
    }
    await apiRequest(page, `/api/library/artists/${artist.mbid}`, {
      method: "PUT",
      body: { monitored: false, monitorOption: "none" },
    });
  }
});
