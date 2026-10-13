import { expect, test } from "@playwright/test";
import { recordViewTransitions } from "./helpers.js";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = {
  id: "pick-header-artist",
  name: "Pick Header Artist",
  "appears-on-release-groups": [],
  tags: [],
  genres: [],
};
const album = {
  id: "pick-header-album",
  title: "Pick Header Album",
  "primary-type": "Album",
  "secondary-types": [],
  "first-release-date": "2001-05-26",
};
const albumDetails = { ...album, rating: { value: 4.5, "votes-count": 12 } };
const tracks = Array.from({ length: 7 }, (_, index) => ({
  id: `pick-header-track-${index + 1}`,
  title: `Pick Header Track ${index + 1}`,
  trackNumber: index + 1,
  length: 600_000,
  preview_url: `https://previews.invalid/pick-header-track-${index + 1}.mp3`,
}));

const cover = "/pick-header-cover.svg";

async function fixture(page, { withCover = false } = {}) {
  await page.route(`**${cover}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e0218a"/></svg>',
    }),
  );
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (path === "/health") return json({ lidarrConfigured: true });
    if (path === `/artists/${artist.id}/stream`) {
      const events = {
        artist: { ...artist, "release-groups": [album] },
        cover: { images: [] },
        library: { exists: false },
        complete: {},
      };
      return route.fulfill({
        contentType: "text/event-stream",
        body: Object.entries(events)
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          .join(""),
      });
    }
    if (path === `/artists/release-group/${album.id}`) return json(albumDetails);
    if (path === `/artists/release-group/${album.id}/tracks`) return json(tracks);
    if (path === "/users/me/lidarr-preferences") {
      return json({ configured: true, rootFolders: [{ path: "/fixture-music" }],
        qualityProfiles: [{ id: 1, name: "Fixture quality" }], tags: [] });
    }
    if (path === "/library/lookup/batch") {
      return json(Object.fromEntries((request.postDataJSON()?.mbids || []).map((id) => [id, false])));
    }
    if (path.startsWith("/library/lookup/")) return json({ exists: false });
    if (path === "/library/albums/lookup/batch") return json({ [album.id]: { inLibrary: false } });
    if (path.endsWith("/cover")) return json({ images: [] });
    if (path === "/artists/release-groups/covers") {
      return json({ covers: withCover ? { [album.id]: { image: cover, notFound: false } } : {} });
    }
    if (path === "/settings") return json({});
    if (path === "/library/favorites") return json({});
    return json([]);
  });
}

test("the artist pick shows the album page header with its actions in one row", async ({ page }) => {
  await recordViewTransitions(page, ".artist-pick-panel");
  await fixture(page);
  await page.goto(`/artist/${artist.id}`);
  const panel = page.locator(".artist-pick-panel");

  const heading = panel.getByRole("heading", { name: album.title, level: 2 });
  await expect(heading).toBeVisible();
  await expect(heading.getByRole("link", { name: album.title, exact: true })).toHaveAttribute(
    "href",
    `/artist/${artist.id}/release/${album.id}`,
  );
  await expect(panel.getByText("May 26, 2001 · Album · 7 tracks · 1 hr 10 min · 4.5 rating", { exact: true }))
    .toBeVisible();

  const actions = panel.locator(".native-library-detail__actions");
  await expect(actions).toHaveCount(1);
  await expect(actions.getByRole("button", { name: `Play ${album.title} previews`, exact: true }))
    .toBeEnabled();
  await expect(actions.getByRole("button", { name: "Download album", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Share album", exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  await expect(panel.getByText("Pick Header Track 6", { exact: true })).toBeVisible();
  await expect(panel.getByText("Pick Header Track 7", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Show all 7 tracks", exact: true }).click();
  await expect(panel.getByText("Pick Header Track 7", { exact: true })).toBeVisible();

  await heading.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/artist/${artist.id}/release/${album.id}$`));
  await expect(page.getByRole("heading", { name: album.title, level: 1 })).toBeVisible();

  await page.goBack();
  await expect(heading).toBeVisible();
  await page.evaluate(() => {
    window.__routeTransitions = [];
  });
  await heading.getByRole("link").click();
  await expect(page.getByRole("heading", { name: album.title, level: 1 })).toBeVisible();
  expect(await page.evaluate(() => window.__routeTransitions)).toEqual([
    [{ name: "shared-artwork", inScope: true }],
  ]);
  await expect(page.locator("[style*=view-transition-name]")).toHaveCount(0);
});

test("the artist pick keeps its actions in one row on a tablet", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await fixture(page);
  await page.goto(`/artist/${artist.id}`);
  const panel = page.locator(".artist-pick-panel");
  await expect(panel.getByText("May 26, 2001 · Album · 7 tracks · 1 hr 10 min · 4.5 rating", { exact: true }))
    .toBeVisible();
  const actions = panel.locator(".native-library-detail__actions");
  const names = [`Play ${album.title} previews`, "Download album", "Share album"];
  for (const name of names) await expect(actions.getByRole("button", { name, exact: true })).toBeVisible();

  const centers = await actions.evaluate(
    (row, labels) =>
      labels.map((label) => {
        const box = row.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    names,
  );
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4);
});

async function panelCornerColors(panel) {
  const box = await panel.boundingBox();
  const png = (await panel.screenshot()).toString("base64");
  return panel.page().evaluate(
    async ({ png, width, height }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement("canvas"), {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const scale = image.naturalWidth / width;
      const pixel = (x, y) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
      return { topLeft: pixel(24, 4), bottomRight: pixel(width - 24, height - 4) };
    },
    { png, width: box.width, height: box.height },
  );
}

for (const colorScheme of ["light", "dark"]) {
  test(`the artist pick takes a ${colorScheme} tint from its cover and stays plain without one`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await fixture(page, { withCover: true });
    await page.goto(`/artist/${artist.id}`);
    const panel = page.locator(".artist-pick-panel");
    await expect(panel.locator(`img[src="${cover}"]`)).toBeVisible();
    await expect
      .poll(async () => {
        const { topLeft, bottomRight } = await panelCornerColors(panel);
        return topLeft[0] - topLeft[1] - (bottomRight[0] - bottomRight[1]);
      })
      .toBeGreaterThan(8);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await fixture(page);
    await page.goto(`/artist/${artist.id}`);
    await expect(panel.getByRole("heading", { name: album.title, level: 2 })).toBeVisible();
    await expect(panel.locator("img")).toHaveCount(0);
    const { topLeft, bottomRight } = await panelCornerColors(panel);
    expect(topLeft).toEqual(bottomRight);
  });
}
