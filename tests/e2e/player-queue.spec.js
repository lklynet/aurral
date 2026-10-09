import { expect, test } from "@playwright/test";

const PLAYLIST_ID = "e2e-player-queue";
const PLAYLIST_NAME = "E2E queue";
const TRACK_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const TRACK_SECONDS = 60;
const GAPLESS_PLAYLIST_ID = "e2e-player-gapless";
const GAPLESS_PLAYLIST_NAME = "E2E gapless";
const GAPLESS_TRACK_SECONDS = 4;
const AUDIO_LATENCY_MS = 1000;

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
const gaplessWav = silentWav(GAPLESS_TRACK_SECONDS);

function routeEditorialPlaylist(page, id, name, seconds, prefix = "") {
  return page.route(`**/api/discover/editorial/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name,
        description: null,
        artworkUrl: null,
        libraryPlaylistId: null,
        tracks: TRACK_NAMES.map((trackName) => ({
          trackName,
          artistName: "E2E Artist",
          albumName: null,
          durationMs: seconds * 1000,
          preview_url: `/e2e-audio/${prefix}${trackName}.wav`,
          artworkUrl: null,
        })),
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await routeEditorialPlaylist(page, PLAYLIST_ID, PLAYLIST_NAME, TRACK_SECONDS);
  await routeEditorialPlaylist(page, GAPLESS_PLAYLIST_ID, GAPLESS_PLAYLIST_NAME, GAPLESS_TRACK_SECONDS, "gapless-");
  await page.route("**/e2e-audio/*.wav", async (route) => {
    const gapless = route.request().url().includes("/gapless-");
    if (gapless) await new Promise((resolve) => setTimeout(resolve, AUDIO_LATENCY_MS));
    const body = gapless ? gaplessWav : wav;
    const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
    const headers = { "content-type": "audio/wav", "accept-ranges": "bytes" };
    if (!match) return route.fulfill({ status: 200, headers, body });
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : body.length - 1;
    return route.fulfill({
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
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

test("shuffle stays on after the player closes and shuffles the next queue after its first track", async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.reload();
  const player = playerControls(page);
  const playAll = page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` });
  await playAll.click();
  await waitUntilPlaying(player);
  await player.shuffle.click();
  await expect(player.shuffle).toHaveAccessibleName("Disable shuffle");
  await page.getByRole("button", { name: "Close player" }).click();
  await expect(player.bar).toHaveCount(0);

  await playAll.click();
  await expect(player.shuffle).toHaveAccessibleName("Disable shuffle");
  const played = [await player.title.textContent()];
  for (let step = 1; step < TRACK_NAMES.length; step += 1) {
    await player.next.click();
    await expect(player.title).not.toHaveText(played.at(-1));
    played.push(await player.title.textContent());
  }
  expect(played).toEqual(["Alpha", "Charlie", "Delta", "Echo", "Bravo"]);
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

test("the next track starts without waiting for the network when the current one ends", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaEvents = [];
    const observed = new WeakSet();
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function observeLoad(...args) {
      if (!observed.has(this)) {
        observed.add(this);
        for (const type of ["playing", "ended"]) {
          this.addEventListener(type, () =>
            window.__mediaEvents.push({ type, src: this.currentSrc, at: performance.now() }),
          );
        }
      }
      return load.apply(this, args);
    };
  });
  await page.goto(`/discover/playlists/deezer/${GAPLESS_PLAYLIST_ID}`);
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${GAPLESS_PLAYLIST_NAME} previews` }).click();
  await expect(player.title).toHaveText("Alpha");
  await expect(player.title).toHaveText("Bravo", { timeout: (GAPLESS_TRACK_SECONDS + 4) * 1000 });

  const gap = () =>
    page.evaluate(() => {
      const events = window.__mediaEvents;
      const ended = events.find((event) => event.type === "ended" && event.src.includes("gapless-Alpha"));
      const started = events.find((event) => event.type === "playing" && event.src.includes("gapless-Bravo"));
      return ended && started ? Math.round(started.at - ended.at) : null;
    });
  await expect.poll(gap, { timeout: AUDIO_LATENCY_MS * 3 }).not.toBeNull();
  const measured = await gap();
  test.info().annotations.push({ type: "gap-ms", description: String(measured) });
  console.log(`gap between tracks: ${measured}ms`);
  expect(measured).toBeLessThan(150);
});

test("keyboard shortcuts control playback without taking keys from fields and buttons", async ({ page }) => {
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  const heading = page.getByRole("heading", { name: PLAYLIST_NAME });

  await heading.click();
  await page.keyboard.press("Space");
  await expect(player.playPause).toHaveAccessibleName("Play");
  await player.seek.focus();
  await player.seek.press("Home");
  await heading.click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:10 of 1:00");
  await page.keyboard.press("ArrowLeft");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:05 of 1:00");

  await page.keyboard.press("Shift+ArrowRight");
  await expect(player.title).toHaveText("Bravo");
  await waitUntilPlaying(player);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(player.title).toHaveText("Alpha");

  await player.next.focus();
  await page.keyboard.press("Space");
  await expect(player.title).toHaveText("Bravo");
  await waitUntilPlaying(player);

  const search = page.getByRole("textbox", { name: "Search music, artists, or tags" });
  await search.click();
  await page.keyboard.type(" m");
  await expect(search).toHaveValue(" m");
  await expect(player.playPause).toHaveAccessibleName("Pause");
  await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();

  await heading.click();
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  await page.keyboard.press("Control+m");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();
});

test("unmuting after a reload restores the volume from before mute", async ({ page }) => {
  const player = playerControls(page);
  const volume = page.getByRole("slider", { name: "Volume" });
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  await volume.fill("40");
  await page.getByRole("button", { name: "Mute" }).click();
  await expect(volume).toHaveValue("0");

  await page.reload();
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  await expect(volume).toHaveValue("0");
  await page.getByRole("button", { name: "Unmute" }).click();
  await expect(volume).toHaveValue("40");
});

test("lock-screen controls seek, follow play and pause, and clear with the queue", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaSession = { handlers: {}, positions: [] };
    const session = navigator.mediaSession;
    const setActionHandler = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => {
      window.__mediaSession.handlers[action] = handler;
      setActionHandler(action, handler);
    };
    session.setPositionState = (state) => window.__mediaSession.positions.push(state ?? null);
  });
  await page.reload();
  const player = playerControls(page);
  await page.getByRole("button", { name: `Play ${PLAYLIST_NAME} previews` }).click();
  await waitUntilPlaying(player);
  await player.playPause.click();
  await expect(player.playPause).toHaveAccessibleName("Play");

  const lastPosition = () => page.evaluate(() => window.__mediaSession.positions.at(-1));
  const runAction = (action, details = {}) =>
    page.evaluate(([name, value]) => window.__mediaSession.handlers[name]?.({ action: name, ...value }), [action, details]);
  await expect.poll(lastPosition).toMatchObject({ duration: 60, playbackRate: 1 });
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");

  await runAction("seekto", { seekTime: 20 });
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:20 of 1:00");
  await runAction("seekforward");
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:30 of 1:00");
  expect((await lastPosition()).position).toBe(30);
  await runAction("seekbackward", { seekOffset: 5 });
  await expect(player.seek).toHaveAttribute("aria-valuetext", "0:25 of 1:00");
  expect((await lastPosition()).position).toBe(25);

  await runAction("play");
  await waitUntilPlaying(player);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe("playing");
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe("Alpha");

  await page.getByRole("button", { name: "Close player" }).click();
  await expect.poll(lastPosition).toBeNull();
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("none");
});
