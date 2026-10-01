import { test, expect } from "@playwright/test";

async function openApp(page) {
  if (!process.env.AUTH_USER || !process.env.AUTH_PASSWORD) throw new Error("AUTH_USER and AUTH_PASSWORD are required");
  await page.goto("/");
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
}

test("one bulk request reports partial completion against its original playlist", async ({ page }) => {
  const tracks = [1, 2].map((id) => ({ id: `bulk-${id}`, artistName: "Disposable artist", trackName: `Bulk track ${id}`, status: "pending", playlistType: "bulk-source" }));
  const source = { id: "bulk-source", name: "Disposable bulk source", tracks, trackCount: 2 };
  const target = { id: "bulk-target", name: "Disposable bulk target", tracks: [], trackCount: 0 };
  const status = { flows: [], sharedPlaylists: [source, target], worker: {}, capabilities: { unavailableSources: {} } };
  const submissions = [];
  let resultReads = 0;
  await page.routeWebSocket("**/ws", () => {});
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
  await expect(page.getByText("Move queued for 2 tracks", { exact: true })).toBeVisible();
  await page.goBack();
  await page.locator(".playlists-page__title").filter({ hasText: target.name }).click();
  await expect(page.getByText(`1 track moved from ${source.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${source.name}: 1 track failed. Provider cleanup failed`, { exact: true })).toBeVisible();
  expect(submissions).toEqual([{ jobIds: tracks.map((track) => track.id), target: { playlistId: target.id } }]);
});
