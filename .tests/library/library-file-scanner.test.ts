import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  applyMetadataEnrichment,
  buildMetadataRecord,
} from "../../backend/services/libraryFileScanner.ts";

const RELEASE_GROUP = "11111111-1111-4111-8111-111111111111";
const RELEASE = "22222222-2222-4222-8222-222222222222";

test("an untagged download files under its job's release group and release, never one as the other", () => {
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
});
