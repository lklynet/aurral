import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { http } from "../../lib/http.ts";
import { getReleaseFeed, getReleaseRail } from "../../backend/services/discovery/releaseFeed.ts";
import { refreshFreshReleases } from "../../backend/services/discovery/freshReleases.ts";
import { upsertReleaseCalendarEntry } from "../../backend/services/releaseCalendarStore.ts";
import { upsertLibraryArtist } from "../../backend/services/libraryMediaStore.ts";

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const RECOMMENDED = mbid(1);

vi.mock("../../backend/services/discovery/userDiscovery.ts", () => ({
  getUserDiscovery: () => ({ body: { recommendations: [{ id: RECOMMENDED }] } }),
}));

test("the release feed merges Library and recommended albums and EPs into dated pages, Library first within each month, and the rail leads with released ones", async () => {
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid(2)}`,
    mbid: mbid(2),
    name: "Library Artist",
    metadata: { id: mbid(2), librarySource: "aurral" },
  });
  const library = [
    [10, "Library Old", "2026-10-01"],
    [11, "Library Recent", "2026-11-10"],
    [12, "Shared", "2026-11-05"],
    [13, "Library Soon", "2026-11-20"],
    [14, "Library Later", "2027-01-15"],
  ] as const;
  for (const [index, title, releaseDate] of library) {
    upsertReleaseCalendarEntry({
      releaseGroupMbid: mbid(index),
      artistId: artist.id,
      title,
      releaseDate,
      releaseType: "Album",
    });
  }
  const recommended = [
    [12, "Shared", "2026-11-05", "Album"],
    [20, "Recommended Recent", "2026-11-08", "Album"],
    [21, "Recommended Soon", "2026-11-14", "EP"],
    [22, "Recommended Single", "2026-11-09", "Single"],
    [23, "Recommended Live", "2026-11-11", "Album", "Live"],
    [24, "Recommended Latest", "2026-11-11", "EP"],
  ] as const;
  vi.spyOn(http, "get").mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: {},
    data: {
      payload: {
        releases: recommended.map(([index, title, releaseDate, type, secondaryType]) => ({
          release_group_mbid: mbid(index),
          release_name: title,
          artist_credit_name: "Recommended Artist",
          artist_mbids: [RECOMMENDED],
          release_group_primary_type: type,
          release_group_secondary_type: secondaryType,
          release_date: releaseDate,
          ...(index === 20 && { caa_id: 77, caa_release_mbid: mbid(30) }),
        })),
      },
    },
  });
  await refreshFreshReleases();
  const now = Date.parse("2026-11-12T12:00:00Z");
  const page = async (when: "released" | "upcoming", offset: number, limit: number) => {
    const feed = await getReleaseFeed({ userId: null, when, offset, limit, now });
    return [feed.releases.map((album) => album.title), feed.hasMore];
  };

  assert.deepEqual(await page("released", 0, 2), [["Library Recent", "Shared"], true]);
  assert.deepEqual(await page("released", 2, 3), [
    ["Recommended Latest", "Recommended Recent", "Library Old"],
    false,
  ]);
  assert.deepEqual(await page("upcoming", 0, 10), [
    ["Library Soon", "Recommended Soon", "Library Later"],
    false,
  ]);
  assert.deepEqual(
    (await getReleaseRail({ userId: null, limit: 6, now })).map((album) => album.title),
    [
      "Library Recent",
      "Shared",
      "Recommended Latest",
      "Recommended Recent",
      "Library Old",
      "Library Soon",
    ],
  );
  const [first] = (await getReleaseFeed({ userId: null, when: "released", limit: 1, now }))
    .releases;
  assert.equal(first?.coverUrl, `/api/artists/release-group/${mbid(11)}/cover/image`);
  const recommendedRecent = (
    await getReleaseFeed({ userId: null, when: "released", limit: 10, now })
  ).releases.find((album) => album.title === "Recommended Recent");
  assert.equal(
    recommendedRecent?.coverUrl,
    `https://coverartarchive.org/release/${mbid(30)}/77-500.jpg`,
  );
});
