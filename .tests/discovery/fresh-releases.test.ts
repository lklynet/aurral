import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { http } from "../../lib/http.ts";
import {
  getFreshReleasesByArtists,
  refreshFreshReleases,
} from "../../backend/services/discovery/freshReleases.ts";
import { clearMetadataProviderCaches } from "../../backend/services/providers/metadataProvider.ts";

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const RECOMMENDED = mbid(1);
const OTHER = mbid(2);

const release = (index: number, artist: string, type: string, date: string) => ({
  id: mbid(100 + index),
  title: `Release ${index}`,
  artistName: artist === RECOMMENDED ? "Recommended Artist" : "Other Artist",
  artistIds: [artist],
  type,
  releaseDate: date,
});

test("new releases come from AurralBrainz in the background and list only the given artists' releases from the last and next 30 days", async () => {
  vi.setSystemTime(Date.parse("2026-11-01T12:00:00Z"));
  clearMetadataProviderCaches();
  const requests: string[] = [];
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    requests.push(new URL(url).pathname);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: {
        releases: [
          release(1, RECOMMENDED, "Album", "2026-10-20"),
          release(2, RECOMMENDED, "Album", "2026-09-01"),
          release(3, OTHER, "Album", "2026-10-22"),
          release(4, RECOMMENDED, "Single", "2026-11-05"),
        ],
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
  assert.deepEqual(requests, ["/v1/fresh-releases"]);
});
