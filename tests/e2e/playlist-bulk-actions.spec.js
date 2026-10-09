import { test, expect } from "@playwright/test";
import { openApp } from "./helpers.js";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

test("one bulk request reports partial completion against its original playlist", async ({ page }) => {
  const tracks = [1, 2].map((id) => ({ id: `bulk-${id}`, artistName: "Disposable artist", trackName: `Bulk track ${id}`, status: "pending", playlistType: "bulk-source" }));
  const source = { id: "bulk-source", name: "Disposable bulk source", tracks, trackCount: 2 };
  const target = { id: "bulk-target", name: "Disposable bulk target", tracks: [], trackCount: 0 };
  const status = { flows: [], sharedPlaylists: [source, target], worker: {}, capabilities: { unavailableSources: {} } };
  const submissions = [];
  let resultReads = 0;
  await page.route("**/api/**", (route) => (new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ json: [] })
    : route.continue()));
  await page.route("**/api/health/bootstrap", (route) =>
    route.fulfill({ json: { authRequired: false, onboardingRequired: false } }));
  await page.routeWebSocket("**/ws**", () => {});
  await page.route("**/api/playlists/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/playlists/jobs/*", (route) => route.fulfill({ json: route.request().url().endsWith(source.id) ? tracks : [] }));
  await page.route("**/track-moves", async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: { queued: true, operationId: 101, acceptedJobIds: tracks.map((track) => track.id), rejected: [] } });
  });
  await page.route("**/operations/101", (route) => {
    resultReads++;
    return route.fulfill({ json: resultReads === 1
      ? { state: "queued", outcomes: [] }
      : { state: "completed", targetPlaylistId: target.id, outcomes: [{ jobId: tracks[0].id, status: "moved" }, { jobId: tracks[1].id, status: "failed", message: "Provider cleanup failed" }] } });
  });
  await openApp(page);
  await page.goto("/library/playlists");
  await page.locator(".playlists-page__title").filter({ hasText: source.name }).click();
  await page.getByRole("button", { name: "Select tracks", exact: true }).click();
  await page.getByLabel("Select all tracks").check();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("button", { name: `Add to ${target.name}`, exact: true }).click();
  await expect(page.getByText("No tracks in this playlist yet.", { exact: true })).toBeVisible();
  await page.goBack();
  await page.locator(".playlists-page__title").filter({ hasText: target.name }).click();
  await expect(page.getByText(`Moved 1 track to ${target.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Could not move 1 track to ${target.name}: Provider cleanup failed. It stays in ${source.name}.`, { exact: true })).toBeVisible();
  expect(submissions).toEqual([{ jobIds: tracks.map((track) => track.id), target: { playlistId: target.id } }]);
});

test("removed tracks can be restored in place until their Undo toast closes", async ({ page }) => {
  const tracks = [1, 2, 3].map((id) => ({ id: `undo-${id}`, artistName: "Disposable artist", trackName: `Undo track ${id}`, status: "pending", playlistType: "undo-source" }));
  const source = { id: "undo-source", name: "Disposable undo source", tracks, trackCount: 3 };
  const status = { flows: [], sharedPlaylists: [source], worker: {}, capabilities: { unavailableSources: {} } };
  const submissions = [];
  const removed = new Set();
  await page.route("**/api/**", (route) => (new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ json: [] })
    : route.continue()));
  await page.route("**/api/health/bootstrap", (route) =>
    route.fulfill({ json: { authRequired: false, onboardingRequired: false } }));
  await page.routeWebSocket("**/ws**", () => {});
  await page.route("**/api/playlists/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/playlists/jobs/*", (route) => route.fulfill({
    json: route.request().url().endsWith(source.id) ? tracks.filter((track) => !removed.has(track.id)) : [],
  }));
  await page.route("**/track-removals", async (route) => {
    const body = route.request().postDataJSON();
    submissions.push(body);
    body.jobIds.forEach((id) => removed.add(id));
    await route.fulfill({ json: { queued: true, operationId: 201, acceptedJobIds: body.jobIds, rejected: [] } });
  });
  await page.route("**/operations/201", (route) => route.fulfill({
    json: { state: "completed", outcomes: [...removed].map((jobId) => ({ jobId, status: "removed" })) },
  }));
  const titles = () => page.getByText(/^Undo track \d$/).allInnerTexts();
  const removeTrack = async (name) => {
    await page.getByRole("button", { name: `${name} options`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove from playlist" }).click();
  };

  await openApp(page);
  await page.goto("/library/playlists");
  await page.locator(".playlists-page__title").filter({ hasText: source.name }).click();
  await expect.poll(titles).toEqual(["Undo track 1", "Undo track 2", "Undo track 3"]);

  await removeTrack("Undo track 2");
  await removeTrack("Undo track 1");
  await expect.poll(titles).toEqual(["Undo track 3"]);
  const firstToast = page.locator(".app-toast").filter({ hasText: `Removed Undo track 2 from ${source.name}` });
  const secondToast = page.locator(".app-toast").filter({ hasText: `Removed Undo track 1 from ${source.name}` });
  await secondToast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(titles).toEqual(["Undo track 1", "Undo track 3"]);
  await expect(page.getByText(`Restored Undo track 1 to ${source.name}`, { exact: true })).toBeVisible();
  expect(submissions).toEqual([]);

  await firstToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect.poll(() => submissions).toEqual([{ jobIds: ["undo-2"] }]);
  await expect.poll(titles).toEqual(["Undo track 1", "Undo track 3"]);
});
