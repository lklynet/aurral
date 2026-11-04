import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import {
  getDeezerPreviewLink,
  selectDeezerTrackPreview,
} from "../../backend/services/apiClients/deezer.ts";

test("Deezer preview matching requires the requested artist and track", () => {
  const preview = selectDeezerTrackPreview(
    [
      {
        id: 1,
        title: "Song",
        title_short: "Song",
        artist: { name: "Wrong Artist" },
        preview: "wrong.mp3",
      },
      {
        id: 2,
        title: "Song",
        title_short: "Song",
        artist: { name: "Artist" },
        preview: "right.mp3",
      },
    ],
    { artistName: "Artist", trackName: "Song" },
  );

  assert.equal(preview?.preview, "right.mp3");
});

test("Deezer preview matching accepts the main artist of a shared credit only", () => {
  const candidates = [{ id: 1, title: "Gravity", artist: { name: "John" }, preview: "john.mp3" }];

  assert.equal(
    selectDeezerTrackPreview(candidates, { artistName: "John feat. Mayer", trackName: "Gravity" })
      ?.preview,
    "john.mp3",
  );
  assert.equal(
    selectDeezerTrackPreview(candidates, { artistName: "John Mayer", trackName: "Gravity" }),
    null,
  );
});

test("Deezer preview matching prefers the full artist over the main artist of a credit", () => {
  const preview = selectDeezerTrackPreview(
    [
      { id: 1, title: "See You Again", artist: { name: "Tyler" }, preview: "tyler.mp3" },
      {
        id: 2,
        title: "See You Again",
        artist: { name: "Tyler, The Creator" },
        preview: "creator.mp3",
      },
    ],
    { artistName: "Tyler, The Creator", trackName: "See You Again" },
  );

  assert.equal(preview?.preview, "creator.mp3");
});

test("a delisted Deezer track previews a live copy of the same release", async () => {
  const track = (id: number, title: string, album: string, preview = "", isrc?: string) => ({
    id,
    title,
    isrc,
    preview,
    artist: { name: "Brand New" },
    album: { title: album },
  });
  const routes: Record<string, unknown> = {
    "/track/101": track(101, "Sic Transit Gloria", "Deja Entendu", "", "USRZR0300001"),
    "/track/isrc:USRZR0300001": track(501, "Sic Transit Gloria", "Deja Entendu", "live-501.mp3"),
    "/track/102": track(102, "The Shower Scene", "Your Favorite Weapon", "", "USRZR0389001"),
    "/track/isrc:USRZR0389001": track(102, "The Shower Scene", "Your Favorite Weapon"),
    "/track/103": track(103, "Jude Law", "Your Favorite Weapon"),
    "/track/104": { ...track(104, "Кукушка", "Чёрный альбом"), artist: { name: "Кино" } },
  };
  const searches: Record<string, unknown[]> = {
    "Brand New The Shower Scene": [
      track(502, "The Shower Scene (2000 Demo)", "Your Favorite Weapon (Deluxe)", "demo.mp3"),
      track(503, "The Shower Scene", "Your Favorite Weapon", "live-503.mp3", "USRZR1132601"),
    ],
    "Brand New Jude Law": [track(504, "Jude Law", "Live at Leeds", "live.mp3")],
    "Кино Кукушка": [
      { ...track(505, "Кукушка", "Звезда по имени Солнце", "other.mp3"), artist: { name: "Кино" } },
      { ...track(506, "Кукушка", "Чёрный альбом", "live-506.mp3"), artist: { name: "Кино" } },
    ],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const body =
      url.pathname === "/search"
        ? { data: searches[url.searchParams.get("q") ?? ""] ?? [] }
        : (routes[url.pathname] ?? { error: { code: 800 } });
    return Response.json(body);
  });

  assert.equal(await getDeezerPreviewLink("101"), "live-501.mp3");
  assert.equal(await getDeezerPreviewLink("102"), "live-503.mp3");
  assert.equal(await getDeezerPreviewLink("103"), null);
  assert.equal(await getDeezerPreviewLink("104"), "live-506.mp3");
});
