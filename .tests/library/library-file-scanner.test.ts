import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  applyMetadataEnrichment,
  buildMetadataRecord,
} from "../../backend/services/libraryFileScanner.ts";
import {
  upsertLibraryAlbum,
  upsertLibraryArtist,
} from "../../backend/services/libraryMediaStore.ts";
import { VARIOUS_ARTISTS_MBID } from "../../lib/artistCredit.ts";

const RELEASE_GROUP = "11111111-1111-4111-8111-111111111111";
const RELEASE = "22222222-2222-4222-8222-222222222222";
const OTHER_GROUP = "33333333-3333-4333-8333-333333333333";
const GROUPLESS_RELEASE = "44444444-4444-4444-8444-444444444444";

test("an untagged download files under its job's release group and release, never one as the other, and a file tagged with another group keeps no job release", () => {
  const record = (releaseMbid: string | null) =>
    buildMetadataRecord(
      applyMetadataEnrichment(
        { common: {} },
        { artistName: "Artist", albumName: "Album", albumMbid: RELEASE_GROUP, releaseMbid },
      ),
      "/music/Artist/Album/01 Song.flac",
      "/music",
    );

  assert.deepEqual(
    [record(RELEASE).releaseGroupMbid, record(RELEASE).albumMbid],
    [RELEASE_GROUP, RELEASE],
  );
  assert.deepEqual([record(null).releaseGroupMbid, record(null).albumMbid], [RELEASE_GROUP, null]);

  const retagged = buildMetadataRecord(
    applyMetadataEnrichment(
      { common: { mbReleaseGroupId: OTHER_GROUP } },
      { albumMbid: RELEASE_GROUP, releaseMbid: RELEASE },
    ),
    "/music/Artist/Album/01 Song.flac",
    "/music",
  );
  assert.deepEqual([retagged.releaseGroupMbid, retagged.albumMbid], [OTHER_GROUP, null]);

  const artist = upsertLibraryArtist({ identityKey: "artist:groupless", name: "Artist" });
  upsertLibraryAlbum({
    identityKey: `album:${GROUPLESS_RELEASE}`,
    mbid: GROUPLESS_RELEASE,
    artistId: artist.id,
    title: "Album",
  });
  upsertLibraryAlbum({
    identityKey: `release-group:${RELEASE_GROUP}`,
    mbid: RELEASE,
    releaseGroupMbid: RELEASE_GROUP,
    artistId: artist.id,
    title: "Album",
  });
  const keyedByRelease = (albumMbid: string) => {
    const { releaseGroupMbid, albumMbid: releaseMbid } = buildMetadataRecord(
      applyMetadataEnrichment({ common: {} }, { albumMbid }),
      "/music/Artist/Album/01 Song.flac",
      "/music",
    );
    return [releaseGroupMbid, releaseMbid];
  };
  assert.deepEqual(keyedByRelease(GROUPLESS_RELEASE), [null, GROUPLESS_RELEASE]);
  assert.deepEqual(keyedByRelease(RELEASE), [RELEASE_GROUP, RELEASE]);
});

test("a Various Artists album files under Various Artists when only its tracks carry artist IDs", () => {
  const identity = (tags: Record<string, string>) => {
    const { artistKey, artistMbid, artistMbids } = buildMetadataRecord(
      { common: { albumArtist: "Various Artists", artist: "Blue Swede", ...tags } },
      "/music/Various Artists/Awesome Mix/01 Hooked on a Feeling.flac",
      "/music",
    );
    return { artistKey, artistMbid, artistMbids };
  };

  assert.deepEqual(
    identity({ mbArtistId: "33333333-3333-4333-8333-333333333333" }),
    identity({ mbAlbumArtistId: VARIOUS_ARTISTS_MBID }),
  );
});

test("an album artist tag holding several NUL-separated values names the album for its first artist", () => {
  const names = (taggedAlbumArtist: string) => {
    const { artistName, albumArtist } = buildMetadataRecord(
      {
        common: {
          artist: "Proxy",
          artists: ["Proxy"],
          albumArtist: taggedAlbumArtist,
          albumArtists: [taggedAlbumArtist],
        },
      },
      "/music/Proxy/Bubble Bite EP/01 Bubble.mp3",
      "/music",
    );
    return [artistName, albumArtist];
  };

  assert.deepEqual(names("Proxy\0﻿\0﻿"), ["Proxy", "Proxy"]);
  assert.deepEqual(names("Mason Maynard\0﻿Green Velvet"), ["Mason Maynard", "Mason Maynard"]);
});

test("a release date tagged day or month first is stored year first", () => {
  const releaseDate = (date: string) =>
    buildMetadataRecord({ common: { date } }, "/music/Artist/Album/01 Song.mp3", "/music")
      .releaseDate;

  assert.deepEqual(
    [
      "25/03/2022",
      "03/25/2022",
      "25.03.2022",
      "05/05/2022",
      "05/04/2022",
      "2022-03-25",
      "Unknown",
      "",
    ].map(releaseDate),
    ["2022-03-25", "2022-03-25", "2022-03-25", "2022-05-05", "2022", "2022-03-25", "Unknown", null],
  );
  assert.equal(
    buildMetadataRecord({ common: { year: 2022 } }, "/music/Artist/Album/01 Song.mp3", "/music")
      .releaseDate,
    "2022",
  );
});
