import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mergeFriendRows } from "../../frontend/src/components/friendRows.ts";

const track = (title: string) => ({ title, artist: "Radiohead", album: null, artworkUrl: "" });
const played = (title: string, at: number) => ({ ...track(title), at });

test("people on this server and aurral.org friends share one list, playing first, then most recent", () => {
  const rows = mergeFriendRows(
    [
      {
        id: 1,
        username: "mia",
        handle: "mia_k",
        lastPlayedAt: 10,
        nowPlaying: null,
        lastPlayed: played("Airbag", 10),
      },
      {
        id: 2,
        username: "kit",
        handle: null,
        lastPlayedAt: 20,
        nowPlaying: null,
        lastPlayed: played("Creep", 20),
      },
      {
        id: 3,
        username: "ash",
        handle: "ash",
        lastPlayedAt: 5,
        nowPlaying: null,
        lastPlayed: played("Lucky", 5),
      },
    ],
    [
      { handle: "mia_k", nowPlaying: track("Nude"), lastPlayed: played("Nude", 40) },
      { handle: "ash", nowPlaying: null, lastPlayed: played("Videotape", 30) },
      { handle: "nova", nowPlaying: null, lastPlayed: null },
      { handle: "sam", nowPlaying: track("Reckoner") },
    ],
  );
  assert.deepEqual(
    rows.map((row) => [
      row.name,
      row.local,
      row.to,
      row.nowPlaying?.title ?? null,
      row.lastPlayed?.title ?? null,
    ]),
    [
      ["mia", true, "/people/mia", "Nude", "Nude"],
      ["@sam", false, "/friends/sam", "Reckoner", null],
      ["ash", true, "/people/ash", null, "Videotape"],
      ["kit", true, "/people/kit", null, "Creep"],
      ["@nova", false, "/friends/nova", null, null],
    ],
  );
});
