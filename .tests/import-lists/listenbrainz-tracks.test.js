import test from "node:test";
import assert from "node:assert/strict";
import { parseListenBrainzPlaylist } from "../../backend/services/importLists/listenbrainzTracks.js";

test("parseListenBrainzPlaylist maps JSPF tracks and reports skipped entries", () => {
  const { tracks, stats } = parseListenBrainzPlaylist({
    playlist: {
      track: [
        {
          creator: "Artist A",
          title: "Song A",
          album: "Album A",
          duration: 185000,
          identifier: ["https://musicbrainz.org/recording/track-mbid"],
          extension: {
            "https://musicbrainz.org/doc/jspf#track": {
              artist_identifiers: ["https://musicbrainz.org/artist/artist-mbid"],
              release_identifier: "https://musicbrainz.org/release/album-mbid",
            },
          },
        },
        {
          creator: "Artist A",
          title: "Song A",
          album: "Album A",
          duration: 185000,
          identifier: ["https://musicbrainz.org/recording/track-mbid"],
          extension: {
            "https://musicbrainz.org/doc/jspf#track": {
              artist_identifiers: ["https://musicbrainz.org/artist/artist-mbid"],
              release_identifier: "https://musicbrainz.org/release/album-mbid",
            },
          },
        },
        { creator: "Artist B" },
      ],
    },
  });

  assert.deepEqual(tracks, [
    {
      artistName: "Artist A",
      trackName: "Song A",
      albumName: "Album A",
      artistMbid: "artist-mbid",
      albumMbid: "album-mbid",
      trackMbid: "track-mbid",
      releaseYear: null,
      durationMs: 185000,
      artistAliases: [],
      reason: null,
    },
  ]);
  assert.deepEqual(stats, { incomplete: 1, duplicate: 1 });
});

test("parseListenBrainzPlaylist uses the primary artist name for a multi-artist credit", () => {
  const { tracks } = parseListenBrainzPlaylist({
    playlist: {
      track: [{
        creator: "Marshmello;Lil Peep",
        title: "Spotlight",
        album: "Spotlight",
        identifier: ["https://musicbrainz.org/recording/track-mbid"],
        extension: {
          "https://musicbrainz.org/doc/jspf#track": {
            artist_identifiers: ["https://musicbrainz.org/artist/marshmello-mbid"],
            release_identifier: "https://musicbrainz.org/release/album-mbid",
          },
        },
      }],
    },
  });

  assert.equal(tracks[0].artistName, "Marshmello");
});
