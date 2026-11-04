import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseFile } from "music-metadata";
import taglib from "node-taglib-sharp";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { dbOps }, { writeAudioMetadata }, { clearMetadataProviderCaches }] =
  await setupIsolatedBackend(
    "download-genre-tags",
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/downloadUtils.ts"),
    () => import("../../backend/services/providers/brainzmashProvider.ts"),
  );

const job = {
  trackName: "One More Time",
  artistName: "Daft Punk",
  albumName: "Discovery",
  albumMbid: "48117b90-a16e-34ca-a514-19c702df1158",
};

function makeMp3(name: string, genre: string | null = null) {
  const filePath = path.join(isolatedState.baseDir, name);
  const result = spawnSync(
    "ffmpeg",
    ["-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "anullsrc", "-t", "0.2"]
      .concat(genre ? ["-metadata", `genre=${genre}`] : [])
      .concat(["-c:a", "libmp3lame", filePath]),
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

async function withAlbumGenres(genres: string[] | null, run: () => Promise<unknown>) {
  const server = await createMockHttpServer((_request, response) => {
    if (!genres) {
      response.statusCode = 503;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: job.albumMbid, title: job.albumName, genres }));
  });
  const previous = dbOps.getSettings();
  dbOps.updateSettings({
    integrations: {
      ...previous.integrations,
      metadata: { provider: "brainzmash", baseUrl: server.url, enableNarrowFallbacks: false },
    },
  });
  clearMetadataProviderCaches();
  try {
    await run();
  } finally {
    dbOps.updateSettings(previous);
    clearMetadataProviderCaches();
    await server.close();
  }
}

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("a download is tagged with its album's genres", async () => {
  const filePath = makeMp3("genres.mp3", "Other");
  const genres = ["house", "french house", "disco", "electronic", "dance", "filter house"];

  await withAlbumGenres(genres, () => writeAudioMetadata(filePath, job));

  const tagged = taglib.File.createFromPath(filePath);
  assert.deepEqual(tagged.tag.genres, genres.slice(0, 5));
  tagged.dispose();
});

test("a download keeps its own genre when the album's genres can't be read", async () => {
  const filePath = makeMp3("unreachable.mp3", "Electronic");

  await withAlbumGenres(null, () => writeAudioMetadata(filePath, job));

  const { common } = await parseFile(filePath);
  assert.deepEqual(common.genre, ["Electronic"]);
  assert.equal(common.title, "One More Time");
});
