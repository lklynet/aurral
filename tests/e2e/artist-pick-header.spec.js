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

async function fixture(page, { withCover = false, releaseGroups = [album], previewTracks = [], findVideo = () => null } = {}) {
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
        artist: { ...artist, "release-groups": releaseGroups },
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
    if (path === `/artists/${artist.id}/preview`) return json({ tracks: previewTracks });
    if (path === `/artists/${artist.id}/video`) {
      try {
        return json({ video: findVideo(new URL(request.url()).searchParams.get("trackTitle")) });
      } catch {
        return json({ error: "Video search unavailable" }, 503);
      }
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

test("the artist pick header counts ListenBrainz listeners ahead of the rating", async ({ page }) => {
  await fixture(page, { releaseGroups: [{ ...album, listenerCount: 2621, listenCount: 17712 }] });
  await page.goto(`/artist/${artist.id}`);
  const panel = page.locator(".artist-pick-panel");
  await expect(panel.getByText("May 26, 2001 · Album · 7 tracks · 1 hr 10 min · 2.6K listeners", { exact: true }))
    .toBeVisible();
});

test("artist page release cards give their ListenBrainz listeners to screen readers and on hover", async ({ page }) => {
  await fixture(page, { releaseGroups: [{ ...album, listenerCount: 2621, listenCount: 17712 }] });
  await page.goto(`/artist/${artist.id}`);
  const metric = page.locator(".artist-release-card").filter({ hasText: album.title }).locator(".artist-release-card__metric");
  await expect(metric).toMatchAriaSnapshot("- paragraph: 2,621 listeners on ListenBrainz");
  await metric.hover();
  await expect(page.getByRole("tooltip", { name: "2,621 listeners on ListenBrainz" })).toBeVisible();
});

test("the artist pick stays on the album the user downloads", async ({ page }) => {
  const single = {
    id: "pick-header-single",
    title: "Pick Header Single",
    "primary-type": "Single",
    "secondary-types": [],
    "first-release-date": "2004-02-02",
    listenerCount: 90,
    listenCount: 140,
  };
  await fixture(page, { releaseGroups: [{ ...album, listenerCount: 2621, listenCount: 17712 }, single] });
  const libraryAlbum = { id: 70, mbid: album.id, foreignAlbumId: album.id, title: album.title, monitored: true };
  let requested = false;
  await page.route("**/api/library/downloads/active", (route) =>
    route.fulfill({ json: { albums: requested ? [album.id] : [], artists: [], tracks: [] } }),
  );
  await page.route("**/api/library/albums/request", (route) => {
    requested = true;
    return route.fulfill({
      json: {
        status: "searching",
        artist: { id: 7, mbid: artist.id, foreignArtistId: artist.id, artistName: artist.name },
        album: libraryAlbum,
      },
    });
  });
  await page.route(
    (url) => url.pathname === "/api/library/albums" && url.searchParams.get("artistId") === "7",
    (route) => route.fulfill({ json: [libraryAlbum] }),
  );
  await page.route("**/api/library/downloads/status**", (route) =>
    route.fulfill({ json: { [libraryAlbum.id]: { status: "searching" } } }),
  );
  await page.goto(`/artist/${artist.id}`);
  const panel = page.locator(".artist-pick-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(album.title);

  await panel.getByRole("button", { name: "Download album", exact: true }).click();

  await expect(page.getByText(`Searching for ${album.title}`, { exact: true })).toBeVisible();
  await expect(
    panel.locator(".native-library-detail__actions").getByRole("button", { name: "Downloading", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(album.title);
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
    await page.addInitScript(() => {
      localStorage.setItem("aurralTheme:v2", JSON.stringify({
        version: 2, themeId: "aurral", appearance: "system", matchArtwork: true, themes: [],
      }));
    });
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


test("Popular stays three rows tall and native videos adapt to the available matches", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  let matches = [1, 3, 6];
  const findVideo = title => {
    const rank = Number(title.split(" ").at(-1));
    return matches.includes(rank) ? {
      videoId: `video00000${rank}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/video00000${rank}`,
    } : null;
  };
  await fixture(page, { previewTracks: tracks, findVideo });
  await page.route("https://www.youtube-nocookie.com/**", route => route.fulfill({
    contentType: "text/html", body: "<title>YouTube player fixture</title>",
  }));
  await page.goto(`/artist/${artist.id}`);
  const rows = page.locator(".artist-preview-list .artist-track-row");
  await expect(rows).toHaveCount(6);
  const boxes = await rows.evaluateAll(nodes => nodes.map(node => {
    const { x, y } = node.getBoundingClientRect(); return { x, y };
  }));
  expect(boxes[0].x).toBe(boxes[2].x);
  expect(boxes[3].x).toBeGreaterThan(boxes[0].x);
  expect(boxes[0].y).toBe(boxes[3].y);
  expect(boxes[2].y).toBe(boxes[5].y);
  const videos = page.getByRole("region", { name: "Videos", exact: true });
  await expect(videos.locator("iframe")).toHaveCount(3);
  await expect(videos.locator(".artist-video-title")).toHaveText([tracks[0].title, tracks[2].title, tracks[5].title]);
  await expect(videos.getByRole("button")).toHaveCount(0);
  const rowBottom = (await rows.last().boundingBox()).y + (await rows.last().boundingBox()).height;
  expect((await videos.boundingBox()).y).toBeGreaterThan(rowBottom);
  const videoBoxes = await videos.locator("iframe").evaluateAll(nodes => nodes.map(node => {
    const { x, y } = node.getBoundingClientRect(); return { x, y };
  }));
  expect(new Set(videoBoxes.map(box => box.y)).size).toBe(1);
  expect(new Set(videoBoxes.map(box => box.x)).size).toBe(3);
  await page.screenshot({ path: testInfo.outputPath("artist-videos-desktop.png") });
  for (const remaining of [[1, 6], [3], []]) {
    matches = remaining;
    await page.reload();
    if (matches.length) {
      await expect(videos.locator("iframe")).toHaveCount(matches.length);
      const frameBoxes = await videos.locator("iframe").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
      expect(new Set(frameBoxes).size).toBe(1);
    } else {
      await expect(page.getByRole("status", { name: "Finding videos" })).toHaveCount(0);
      await expect(videos).toHaveCount(0);
    }
  }
  matches = [1, 3, 6];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(rows).toHaveCount(6);
  await expect(videos.locator("iframe")).toHaveCount(3);
  const mobileRows = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
  expect(new Set(mobileRows).size).toBe(1);
  const mobileVideos = await videos.locator("iframe").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  expect(new Set(mobileVideos).size).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await videos.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("artist-videos-mobile.png") });
});

test("video search can be retried while Popular remains usable", async ({ page }) => {
  let failing = true;
  await fixture(page, { previewTracks: tracks, findVideo: () => {
    if (failing) throw new Error("Unavailable");
    return { videoId: "video000001", embedUrl: "https://www.youtube-nocookie.com/embed/video000001" };
  } });
  await page.route("https://www.youtube-nocookie.com/**", route => route.fulfill({ contentType: "text/html", body: "" }));
  await page.goto(`/artist/${artist.id}`);
  const videos = page.getByRole("region", { name: "Videos", exact: true });
  await expect(videos.getByText("Videos could not be loaded.")).toBeVisible();
  await expect(page.locator(".artist-preview-list").getByRole("button", { name: "Play preview", exact: true })).toHaveCount(6);
  failing = false;
  await videos.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(videos.locator("iframe")).toHaveCount(1);
  await expect(videos.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
});
