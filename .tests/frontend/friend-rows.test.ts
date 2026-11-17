import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mergeFriendRows } from "../../frontend/src/components/friendRows.ts";

const playing = (title: string) => ({ title, artist: "Radiohead", album: null, artworkUrl: "" });

test("people on this server and aurral.org friends share one list, playing first", () => {
  const rows = mergeFriendRows(
    [
      { id: 1, username: "mia", handle: "mia_k", lastPlayedAt: 10, nowPlaying: null },
      { id: 2, username: "kit", handle: null, lastPlayedAt: 20, nowPlaying: null },
    ],
    [
      { handle: "mia_k", nowPlaying: playing("Nude") },
      { handle: "nova", nowPlaying: null },
      { handle: "sam", nowPlaying: playing("Reckoner") },
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.name, row.local, row.to, row.nowPlaying?.title ?? null]),
    [
      ["mia", true, "/people/mia", "Nude"],
      ["@sam", false, "/friends/sam", "Reckoner"],
      ["kit", true, "/people/kit", null],
      ["@nova", false, "/friends/nova", null],
    ],
  );
});
