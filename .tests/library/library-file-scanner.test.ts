import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  applyMetadataEnrichment,
  buildMetadataRecord,
} from "../../backend/services/libraryFileScanner.ts";
import { VARIOUS_ARTISTS_MBID } from "../../backend/services/trackMatching/titleText.ts";

const RELEASE_GROUP = "11111111-1111-4111-8111-111111111111";
const RELEASE = "22222222-2222-4222-8222-222222222222";
const OTHER_GROUP = "33333333-3333-4333-8333-333333333333";

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
      { common: { musicbrainz_releasegroupid: OTHER_GROUP } },
      { albumMbid: RELEASE_GROUP, releaseMbid: RELEASE },
    ),
    "/music/Artist/Album/01 Song.flac",
    "/music",
  );
  assert.deepEqual([retagged.releaseGroupMbid, retagged.albumMbid], [OTHER_GROUP, null]);
});

test("a Various Artists album files under Various Artists when only its tracks carry artist IDs", () => {
  const identity = (tags: Record<string, string>) => {
    const { artistKey, artistMbid, artistMbids } = buildMetadataRecord(
      { common: { albumartist: "Various Artists", artist: "Blue Swede", ...tags } },
      "/music/Various Artists/Awesome Mix/01 Hooked on a Feeling.flac",
      "/music",
    );
    return { artistKey, artistMbid, artistMbids };
  };

  assert.deepEqual(
    identity({ musicbrainz_artistid: "33333333-3333-4333-8333-333333333333" }),
    identity({ musicbrainz_albumartistid: VARIOUS_ARTISTS_MBID }),
  );
});
