import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { buildLibraryReleaseGroups } from "../../frontend/src/pages/ArtistDetails/utils.ts";

const owned = (libraryId: string, title: string, releaseGroupMbid: string | null = null) => ({
  libraryId,
  releaseGroupMbid,
  title,
  releaseDate: null,
  partial: false,
  coverUrl: `/api/library/albums/${libraryId}/cover`,
});

const managed = (mbid: string, monitored: boolean, sizeOnDisk = 0) => ({
  id: `lidarr-${mbid}`,
  mbid,
  albumName: mbid,
  monitored,
  statistics: { sizeOnDisk, percentOfTracks: 0 },
});

test("the library tab lists albums with files plus requested albums still missing, once each", () => {
  const releases = buildLibraryReleaseGroups({
    releaseGroups: [
      { id: "rg-hounds", title: "Hounds of Love", "primary-type": "Album" },
      { id: "rg-aerial", title: "Aerial", "primary-type": "Album" },
    ],
    ownedAlbums: [owned("1", "Hounds of Love", "rg-hounds"), owned("2", "Untagged Rip")],
    libraryAlbums: [
      managed("rg-hounds", true),
      managed("rg-aerial", true),
      managed("rg-dreaming", false),
      managed("name:album:untagged rip", true, 1024),
    ],
    requestingAlbum: null,
  });

  assert.deepEqual(
    releases.map(({ id, title, libraryAlbumId, coverUrl }) => ({
      id,
      title,
      libraryAlbumId,
      coverUrl,
    })),
    [
      { id: "rg-hounds", title: "Hounds of Love", libraryAlbumId: undefined, coverUrl: undefined },
      {
        id: "library-2",
        title: "Untagged Rip",
        libraryAlbumId: "2",
        coverUrl: "/api/library/albums/2/cover",
      },
      { id: "rg-aerial", title: "Aerial", libraryAlbumId: undefined, coverUrl: undefined },
    ],
  );
});
