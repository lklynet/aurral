import test from "node:test";
import assert from "node:assert/strict";
import { importFromRepo } from "../helpers/backendTestHarness.js";

const { buildFocusedPlaylistCandidates } = await importFromRepo(
  "backend/services/discoverPlaylistService.js",
);

test("focus candidates include tag, artist, crossover, and listening history playlists", () => {
  const candidates = buildFocusedPlaylistCandidates({
    maxFocusPlaylists: 8,
    topGenres: ["shoegaze", "dream pop"],
    topTags: ["shoegaze", "indie rock", "post-punk"],
    basedOn: [
      { name: "Slowdive", source: "library" },
      { name: "Beach House", source: "library" },
      { name: "Radiohead", source: "lastfm" },
    ],
    historyTopArtists: ["Radiohead", "Bjork", "Portishead"],
    recommendations: [
      {
        name: "Whirr",
        matchedTags: ["shoegaze"],
        tags: ["noise pop"],
      },
    ],
  });

  assert.ok(candidates.length >= 5);
  assert.ok(
    candidates.some((playlist) => playlist.id === "focus-listening-history"),
  );
  assert.equal(
    candidates.find((playlist) => playlist.id === "focus-listening-history")
      ?.relatedArtists?.length,
    3,
  );
  assert.ok(candidates.some((playlist) => playlist.tags.length > 0));
  assert.ok(
    candidates.some(
      (playlist) =>
        playlist.relatedArtists.length > 0 && playlist.tags.length === 0,
    ),
  );
  assert.ok(
    candidates.some(
      (playlist) =>
        playlist.relatedArtists.length > 0 && playlist.tags.length > 0,
    ),
  );
});

test("default flow budget keeps listening history and five auto focus playlists", () => {
  const candidates = buildFocusedPlaylistCandidates({
    maxFocusPlaylists: 5,
    topGenres: ["shoegaze", "dream pop", "indie rock", "post-punk"],
    topTags: ["shoegaze", "dream pop", "indie rock", "post-punk", "noise pop"],
    basedOn: [
      { name: "Slowdive", source: "library" },
      { name: "Beach House", source: "library" },
      { name: "Radiohead", source: "lastfm" },
    ],
    historyTopArtists: ["Radiohead", "Bjork", "Portishead"],
    recommendations: [
      {
        name: "Whirr",
        matchedTags: ["shoegaze"],
        tags: ["noise pop"],
      },
    ],
  });

  assert.ok(
    candidates.some((playlist) => playlist.id === "focus-listening-history"),
  );
  const autoFocusCount = candidates.filter(
    (playlist) => playlist.id !== "focus-listening-history",
  ).length;
  assert.equal(autoFocusCount, 5);
  assert.equal(candidates.length, 6);
});

test("missing listening history backfills the auto focus budget", () => {
  const candidates = buildFocusedPlaylistCandidates({
    maxFocusPlaylists: 5,
    topGenres: ["shoegaze", "dream pop", "indie rock", "post-punk"],
    topTags: ["shoegaze", "dream pop", "indie rock", "post-punk", "noise pop"],
    basedOn: [
      { name: "Slowdive", source: "library" },
      { name: "Beach House", source: "library" },
    ],
    recommendations: [
      {
        name: "Whirr",
        matchedTags: ["shoegaze"],
        tags: ["noise pop"],
      },
    ],
  });

  assert.ok(
    !candidates.some((playlist) => playlist.id === "focus-listening-history"),
  );
  assert.equal(candidates.length, 6);
});
