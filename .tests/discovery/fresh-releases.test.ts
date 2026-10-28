import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import axios from "../../lib/axiosFetch.ts";
import {
  getFreshReleasesByArtists,
  refreshFreshReleases,
} from "../../backend/services/discovery/freshReleases.ts";

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const RECOMMENDED = mbid(1);
const OTHER = mbid(2);

const release = (index: number, artist: string, type: string, date: string) => ({
  release_group_mbid: mbid(100 + index),
  release_name: `Release ${index}`,
  artist_credit_name: artist === RECOMMENDED ? "Recommended Artist" : "Other Artist",
  artist_mbids: [artist],
  release_group_primary_type: type,
  release_date: date,
});

test("new releases come from ListenBrainz in the background and list only the given artists' albums, EPs and singles", async () => {
  const requests: string[] = [];
  vi.spyOn(axios, "get").mockImplementation(async (url, config) => {
    const query = Object.entries(config?.params || {}).map(([key, value]) => `${key}=${value}`);
    requests.push(`${new URL(url).pathname}?${query.join("&")}`);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: {
        payload: {
          releases: [
            release(1, RECOMMENDED, "Album", "2026-10-20"),
            release(2, RECOMMENDED, "Broadcast", "2026-10-21"),
            release(3, OTHER, "Album", "2026-10-22"),
            release(4, RECOMMENDED, "Single", "2026-11-05"),
          ],
        },
      },
    };
  });

  assert.deepEqual(getFreshReleasesByArtists([RECOMMENDED]), []);
  await refreshFreshReleases();

  assert.deepEqual(
    getFreshReleasesByArtists([RECOMMENDED]).map((album) => [
      album.mbid,
      album.albumType,
      album.artistMbid,
      album.artistName,
    ]),
    [
      [mbid(101), "Album", RECOMMENDED, "Recommended Artist"],
      [mbid(104), "Single", RECOMMENDED, "Recommended Artist"],
    ],
  );
  assert.deepEqual(requests, ["/1/explore/fresh-releases/?days=30&past=true&future=true"]);
});
