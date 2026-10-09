import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

requireCredentials();

function makeTrack(file, tags) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "2",
    ...Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
    file,
  ]);
}

test("ingest a folder from Settings, then organize it from the Library", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const artistName = `Ingest Journey ${stamp}`;
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-ingest-journey-"));
  makeTrack(path.join(source, "old rip", "a.flac"), { artist: artistName, album: "First Album", title: "Opening", track: 1 });
  makeTrack(path.join(source, "old rip", "b.flac"), { artist: artistName, album: "First Album", title: "Closing", track: 2 });

  await openApp(page);
  const before = await apiRequest(page, "/api/settings");
  const previousLibraryFiles = before.body?.libraryFiles || {};
  let downloadRoot = null;
  try {
    expect((await apiRequest(page, "/api/settings", {
      method: "POST",
      body: { libraryFiles: { rename: true } },
    })).ok).toBe(true);

    await page.goto("/settings/library-files");
    await expect(page.getByRole("switch", { name: "Rename files" })).toBeChecked();
    const folder = page.locator("#library-ingest-source");
    await folder.fill(source);
    await folder.press("Enter");
    await expect(page.getByText("2 music files found.")).toBeVisible({ timeout: 15_000 });
    await page.locator("#library-ingest-mode").selectOption("copy");
    await page.getByRole("button", { name: "Preview ingest" }).click();

    await expect(page.getByText("Preview ready. Nothing changes until you apply it.")).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByText(`${artistName}/First Album/01 - Opening.flac`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("ingest-preview.png"), fullPage: true });
    await page.getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(page.getByText("Finished.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("ingest-finished.png"), fullPage: true });
    expect(fs.readdirSync(path.join(source, "old rip")).sort()).toEqual(["a.flac", "b.flac"]);

    let artist = null;
    await expect.poll(async () => {
      const artists = await apiRequest(page, "/api/library/artists");
      artist = (artists.body || []).find((entry) => entry.name === artistName) || null;
      return artist?.monitored;
    }, { timeout: 60_000 }).toBe(false);

    const check = await apiRequest(page, "/api/library/files/ingest/check", {
      method: "POST",
      body: { sourcePath: source },
    });
    downloadRoot = check.body?.downloadRoot;
    expect(fs.existsSync(path.join(downloadRoot, artistName, "First Album", "02 - Closing.flac"))).toBe(true);

    await page.goto(`/library/artist/${artist.id}`);
    await page.getByRole("button", { name: `${artistName} options` }).first().click();
    await page.getByRole("menuitem", { name: "Organize files…" }).click();
    const dialog = page.getByRole("dialog", { name: `Organize ${artistName}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Preview changes" }).click();
    await expect(dialog.getByText("Finished. Nothing needed to change.")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("2 files already in order")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("organize-preview.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: `${artistName} options` }).first().click();
    await page.getByRole("menuitem", { name: "Delete artist", exact: true }).click();
    const removal = page.getByRole("alertdialog", { name: "Delete artist" });
    await removal.getByLabel("Delete artist files").check();
    await removal.getByRole("button", { name: "Delete artist" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Artist deleted" })).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(downloadRoot, artistName))).toBe(false);
    const remaining = await apiRequest(page, "/api/library/artists");
    expect((remaining.body || []).some((entry) => entry.name === artistName)).toBe(false);
  } finally {
    await apiRequest(page, "/api/settings", { method: "POST", body: { libraryFiles: previousLibraryFiles } });
    fs.rmSync(source, { recursive: true, force: true });
    if (downloadRoot) fs.rmSync(path.join(downloadRoot, artistName), { recursive: true, force: true });
  }
});
