import { expect, test } from "@playwright/test";

const PLAYLIST_ID = "e2e-player-queue";
const PLAYLIST_NAME = "E2E queue";
const TRACK_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const TRACK_SECONDS = 60;

function silentWav(seconds, sampleRate = 8000) {
  const dataSize = seconds * sampleRate;
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const wav = silentWav(TRACK_SECONDS);

test.beforeEach(async ({ page }) => {
  await page.route(`**/api/discover/editorial/${PLAYLIST_ID}`, (route) =>
    route.fulfill({
      json: {
        id: PLAYLIST_ID,
        name: PLAYLIST_NAME,
        description: null,
        artworkUrl: null,
        libraryPlaylistId: null,
        tracks: TRACK_NAMES.map((name) => ({
          trackName: name,
          artistName: "E2E Artist",
          albumName: null,
          durationMs: TRACK_SECONDS * 1000,
          preview_url: `/e2e-audio/${name}.wav`,
          artworkUrl: null,
        })),
      },
    }),
  );
  await page.route("**/e2e-audio/*.wav", (route) => {
    const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
    const headers = { "content-type": "audio/wav", "accept-ranges": "bytes" };
    if (!match) return route.fulfill({ status: 200, headers, body: wav });
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : wav.length - 1;
    return route.fulfill({
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${wav.length}` },
      body: wav.subarray(start, end + 1),
    });
  });
  await page.goto(`/discover/playlists/deezer/${PLAYLIST_ID}`);
  await expect(page.getByRole("heading", { name: PLAYLIST_NAME })).toBeVisible();
});

function playerControls(page) {
  const bar = page.locator(".global-player__inner");
  return {
    bar,
    title: bar.locator(".global-player__title"),
    playPause: bar.getByRole("button", { name: /^(Play|Pause)$/ }),
    next: bar.getByRole("button", { name: "Next track" }),
    previous: bar.getByRole("button", { name: "Previous track" }),
    shuffle: bar.getByRole("button", { name: /shuffle$/ }),
    seek: bar.getByRole("slider", { name: "Playback position" }),
  };
}

async function waitUntilPlaying(player) {
  await expect(player.playPause).toHaveAccessibleName("Pause");
  await expect(player.seek).toBeEnabled();
}

test("shuffle plays the chosen track first, plays every other track once, and keeps the queue at the end", async ({ page }) => {
  const player = playerControls(page);
  await page.getByRole("button", { name: `Shuffle ${PLAYLIST_NAME} previews` }).click();
  await expect(player.title).toHaveText(new RegExp(`^(${TRACK_NAMES.join("|")})$`));
  const shuffledFirst = await player.title.textContent();
  const chosen = TRACK_NAMES.find((name) => name !== shuffledFirst);

  await page.getByRole("button", { name: `Play ${chosen}`, exact: true }).click();
  await expect(player.title).toHaveText(chosen);

  const played = [chosen];
  for (let step = 1; step < TRACK_NAMES.length; step += 1) {
    await player.next.click();
    await expect(player.title).not.toHaveText(played.at(-1));
    played.push(await player.title.textContent());
  }
  expect([...played].sort()).toEqual([...TRACK_NAMES].sort());

  await player.next.click();
  await expect(player.title).toHaveText(chosen);
  await expect(player.playPause).toHaveAccessibleName("Play");
  await expect(player.shuffle).toHaveAccessibleName("Disable shuffle");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:00 of 1:00");

  await player.playPause.click();
  await waitUntilPlaying(player);
  await expect(player.title).toHaveText(chosen);
});

test("the seek slider moves by useful steps from the keyboard", async ({ page }) => {
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  await player.playPause.click();
  await expect(player.playPause).toHaveAccessibleName("Play");

  await player.seek.focus();
  await player.seek.press("Home");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:00 of 1:00");
  await player.seek.press("ArrowRight");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:05 of 1:00");
  await player.seek.press("ArrowUp");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:10 of 1:00");
  await player.seek.press("ArrowLeft");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:05 of 1:00");
  await player.seek.press("PageUp");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:35 of 1:00");
  await player.seek.press("PageDown");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:05 of 1:00");
});

test("dragging the seek slider holds the dragged time and seeks once on release", async ({ page }) => {
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);

  const box = await player.seek.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 5 });
  const dragged = await player.seek.getAttribute("aria-valuetext");
  const draggedSeconds = Number(/^0:(\d\d)/.exec(dragged)[1]);
  expect(draggedSeconds).toBeGreaterThan(35);

  await page.waitForTimeout(1500);
  await expect(player.seek).toHaveAttribute("aria-valuetext", dragged);

  await page.mouse.up();
  const elapsedSeconds = async () =>
    Number(/^0:(\d\d)/.exec(await player.seek.getAttribute("aria-valuetext"))[1]);
  await expect.poll(elapsedSeconds).toBeGreaterThan(draggedSeconds);
  expect(await elapsedSeconds()).toBeLessThanOrEqual(draggedSeconds + 2);
});

test("previous restarts a track after three seconds and goes back from its start", async ({ page }) => {
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  await player.next.click();
  await expect(player.title).toHaveText("Bravo");
  await waitUntilPlaying(player);

  await player.seek.press("PageUp");
  await expect(player.seek).toHaveAttribute("aria-valuetext", /^0:3\d of 1:00$/);
  await player.previous.click();
  await expect(player.title).toHaveText("Bravo");
  await expect(player.seek).toHaveAttribute("aria-valuetext", /^0:0[0-2] of 1:00$/);

  await player.previous.click();
  await expect(player.title).toHaveText("Alpha");
});
