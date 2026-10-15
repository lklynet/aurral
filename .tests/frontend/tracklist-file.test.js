import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

test("a shared tracklist file brings each track's release and disc back on import", async (t) => {
  const vite = await startFrontendServer();
  t.after(() => vite.close());
  const { buildStaticTracklistPayload, parseTracklistImportFile } = await vite.ssrLoadModule(
    "/src/pages/playlists/flowPageUtils.js",
  );
  const releaseMbid = "9a5b4e83-6d7f-4182-9d9e-0f1a2b3c4d5e";

  const file = JSON.stringify(buildStaticTracklistPayload({
    name: "Road trip",
    tracks: [{
      artistName: "Artist", trackName: "Second Side", albumMbid: "0b6c5f94-7e80-4293-8eaf-1a2b3c4d5e6f",
      releaseMbid, trackNumber: 2, discNumber: 2,
    }],
  }));
  const [playlist] = parseTracklistImportFile(file);

  assert.deepEqual(
    playlist.tracks.map((track) => [track.trackName, track.releaseMbid, track.discNumber, track.trackNumber]),
    [["Second Side", releaseMbid, 2, 2]],
  );
});
