import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { FlowTrackSource } from "../../backend/services/flows/flowTrackSource.ts";

const candidate = (
  entry: Parameters<FlowTrackSource["_buildTrackEntry"]>[0],
  origin: Parameters<FlowTrackSource["_buildBaseCandidate"]>[1],
) => {
  const source = new FlowTrackSource();
  const track = source._buildTrackEntry(entry);
  assert.ok(track);
  return source._buildBaseCandidate(track, origin);
};

const topTrack = (
  name: string,
  albumName: string,
): Awaited<ReturnType<FlowTrackSource["_getArtistTopTrackList"]>>[number] => ({
  name,
  albumName,
  mbid: null,
  durationMs: null,
  popularity: 0,
});

test("year range matching accepts bounds and rejects unknown years when set", () => {
  const source = new FlowTrackSource();
  assert.equal(source._matchesYearRange("1985", null, null), true);
  assert.equal(source._matchesYearRange("1985", 1980, 1989), true);
  assert.equal(source._matchesYearRange("1979", 1980, 1989), false);
  assert.equal(source._matchesYearRange("1990", 1980, 1989), false);
  assert.equal(source._matchesYearRange("2024", 2020, null), true);
  assert.equal(source._matchesYearRange("2019", 2020, null), false);
  assert.equal(source._matchesYearRange(null, 2020, 2026), false);
  assert.equal(source._matchesYearRange(null, null, 2000), false);
  assert.equal(source._matchesYearRange(null, null, null), true);
});

test("candidate selection skips tracks outside the year range", async () => {
  const source = new FlowTrackSource();
  source._resolveTrackReleaseYear = async (track) => track.releaseYear || null;
  const used = new Set<string>();
  const picked = await source._selectFromCandidates(
    [
      candidate({ artistName: "A", trackName: "Old", releaseYear: "1975" }, "focus"),
      candidate({ artistName: "B", trackName: "Fit", releaseYear: "1984" }, "focus"),
      candidate({ artistName: "C", trackName: "New", releaseYear: "2001" }, "focus"),
    ],
    2,
    used,
    1980,
    1989,
  );
  assert.equal(picked.length, 1);
  assert.equal(picked[0].trackName, "Fit");
});

test("assemble applies year range only to focus candidates", async () => {
  const source = new FlowTrackSource();
  source._resolveTrackReleaseYear = async (track) => track.releaseYear || null;
  const plan = await source._assembleFlowPlan({
    candidateMap: {
      focus: [
        candidate({ artistName: "Focus Old", trackName: "Old", releaseYear: "1970" }, "focus"),
        candidate({ artistName: "Focus Fit", trackName: "Fit", releaseYear: "1985" }, "focus"),
      ],
      mix: [candidate({ artistName: "Mix Old", trackName: "Keep", releaseYear: "1960" }, "mix")],
      discover: [],
      trending: [],
    },
    excludeArtistKeys: new Set(),
    targetSize: 2,
    sourceTargets: { focus: 1, mix: 1, discover: 0, trending: 0 },
    yearFrom: 1980,
    yearTo: 1989,
  });
  assert.deepEqual(
    plan.primaryTracks.map((track) => track.trackName),
    ["Fit", "Keep"],
  );
});

test("shortfall backfill does not reintroduce out-of-range focus tracks", async () => {
  const source = new FlowTrackSource();
  source._resolveTrackReleaseYear = async (track) => track.releaseYear || null;
  const plan = await source._assembleFlowPlan({
    candidateMap: {
      focus: [
        candidate({ artistName: "Focus Old", trackName: "Old", releaseYear: "1970" }, "focus"),
        candidate(
          { artistName: "Focus Also Old", trackName: "Older", releaseYear: "1965" },
          "focus",
        ),
      ],
      mix: [candidate({ artistName: "Mix Keep", trackName: "Filler", releaseYear: "1950" }, "mix")],
      discover: [],
      trending: [],
    },
    excludeArtistKeys: new Set(),
    targetSize: 2,
    sourceTargets: { focus: 2, mix: 0, discover: 0, trending: 0 },
    yearFrom: 1980,
    yearTo: 1989,
  });
  assert.deepEqual(
    plan.primaryTracks.map((track) => `${track.source}:${track.trackName}`),
    ["mix:Filler"],
  );
});

test("mix album pick prefers top track list metadata before track.getInfo", () => {
  const source = new FlowTrackSource();
  const ownedTitles = new Set(["owned track"]);
  const ownedAlbums = new Set(["owned album"]);
  const trackList = [topTrack("Owned Track", "Owned Album"), topTrack("Fresh Track", "New Album")];
  const picked = source._pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
    trackList,
    ownedTitles,
    ownedAlbums,
    [{ start: 0, end: 5 }],
  );
  assert.equal(picked?.pick?.name, "Fresh Track");
  assert.equal(picked?.albumName, "New Album");
});

test("library artist key set can be built from preloaded artists", async () => {
  const source = new FlowTrackSource();
  const keys = await source._getLibraryArtistKeySet({
    libraryArtists: [
      {
        id: "artist-id",
        mbid: "artist-mbid",
        artistName: "Library Artist",
      },
    ],
  });

  assert.ok(keys.has("artist-id"));
  assert.ok(keys.has("artist-mbid"));
  assert.ok(keys.has("library artist"));
});

test("release radar picks a release track from metadata before Last.fm fallbacks", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [
    {
      id: "track-id",
      title: "Opening Track",
      trackNumber: 1,
      trackPosition: 1,
      mediumNumber: 1,
      recordingId: "recording-mbid",
      oldRecordingIds: [],
      durationMs: 185000,
      artistId: null,
      releaseMbid: null,
    },
  ];
  source._getLastfmAlbumInfo = async () => {
    throw new Error("Last.fm should not be needed");
  };

  const track = await source._pickTrackFromRelease({
    artistName: "Library Artist",
    albumTitle: "New Album",
    albumMbid: "album-mbid",
    artistMbid: "artist-mbid",
    releaseYear: "2026",
  });

  assert.equal(track?.trackName, "Opening Track");
  assert.equal(track?.albumName, "New Album");
  assert.equal(track?.trackMbid, "recording-mbid");
  assert.equal(track?.durationMs, 185000);
});

test("release radar does not substitute an unrelated artist top track", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [];
  source._getLastfmAlbumInfo = async () => null;
  source._getArtistTopTrackList = async () => [
    topTrack("Sober to Death", "Twin Fantasy (Face to Face)"),
  ];

  const track = await source._pickTrackFromRelease({
    artistName: "Car Seat Headrest",
    albumTitle: "Teen of Denial (Joe's Story)",
    albumMbid: "album-mbid",
    artistMbid: "artist-mbid",
    releaseYear: "2026",
  });

  assert.equal(track, null);
});

test("release radar accepts artist top track fallback only when the album matches", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [];
  source._getLastfmAlbumInfo = async () => null;
  source._getArtistTopTrackList = async () => [
    topTrack("Sober to Death", "Twin Fantasy (Face to Face)"),
    topTrack("Joe Gets Kicked", "Teen of Denial (Joe's Story)"),
  ];

  const track = await source._pickTrackFromRelease({
    artistName: "Car Seat Headrest",
    albumTitle: "Teen of Denial (Joe's Story)",
    albumMbid: "album-mbid",
    artistMbid: "artist-mbid",
    releaseYear: "2026",
  });

  assert.equal(track?.trackName, "Joe Gets Kicked");
  assert.equal(track?.albumName, "Teen of Denial (Joe's Story)");
});
