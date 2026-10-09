import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFile } from "music-metadata";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";
import { readAurralIdentity } from "../../backend/services/downloadUtils.js";

const [
  isolatedState,
  { dbOps },
  { downloadTracker },
  { resolveDownloadRoot },
  { processSystemTask },
] = await setupIsolatedBackend(
  "identity-marker-migration",
  "backend/db/helpers/index.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadPaths.js",
  "backend/services/systemTaskWorker.js",
);

const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "aurral-identity-outside-"));
const ids = {
  artistMbid: "11111111-1111-4111-8111-111111111111",
  albumMbid: "22222222-2222-4222-8222-222222222222",
  trackMbid: "33333333-3333-4333-8333-333333333333",
};
const marker = (identity) => `AURRAL_IDS=${JSON.stringify(identity)}`;

async function createTaggedFile(filePath, codec, tags) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "anullsrc", "-t", "0.05", "-c:a", codec,
    ...Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
    filePath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

function addFinishedJob(finalPath, downloadClient) {
  const id = downloadTracker.addJob({ artistName: "Artist", trackName: path.basename(finalPath) }, "library");
  downloadTracker.setDone(id, finalPath);
  if (downloadClient) downloadTracker.updateDownloadMetadata(id, { downloadClient });
  return id;
}

const readTags = async (filePath) => (await parseFile(filePath, { skipCovers: true })).common;
const legacyMarkerTagIds = async (filePath) =>
  Object.values((await parseFile(filePath, { skipCovers: true })).native)
    .flat()
    .filter((tag) => JSON.stringify(tag.value).includes("AURRAL_IDS="))
    .map((tag) => tag.id);

test.after(async () => {
  await rm(outsideRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("moves the identity marker from the comment or grouping tag to its own tag only in files Aurral downloaded", async () => {
  const root = resolveDownloadRoot();
  const m4a = await createTaggedFile(path.join(root, "Artist", "Album", "01 Marked.m4a"), "aac", {
    comment: marker({ artistMbid: ids.artistMbid, albumMbid: ids.albumMbid }),
    grouping: marker({ trackMbid: ids.trackMbid }),
  });
  const mp3 = await createTaggedFile(path.join(root, "Artist", "Album", "02 Marked.mp3"), "libmp3lame", {
    comment: marker(ids),
  });
  const grouped = await createTaggedFile(path.join(root, "Artist", "Album", "07 Grouped.flac"), "flac", {
    grouping: marker(ids),
  });
  const ownComment = await createTaggedFile(path.join(root, "Artist", "Album", "03 Own.flac"), "flac", {
    comment: "Ripped from my own CD",
  });
  const outside = await createTaggedFile(path.join(outsideRoot, "04 Outside.m4a"), "aac", {
    comment: marker(ids),
  });
  const notDownloaded = await createTaggedFile(path.join(root, "Artist", "Album", "05 Copied.m4a"), "aac", {
    comment: marker(ids),
  });
  addFinishedJob(m4a, "ytdlp");
  addFinishedJob(mp3, "slskd");
  addFinishedJob(grouped, "usenet");
  addFinishedJob(ownComment, "deemix");
  addFinishedJob(outside, "slskd");
  addFinishedJob(notDownloaded, null);
  addFinishedJob(path.join(root, "Artist", "Album", "06 Missing.flac"), "usenet");
  const untouched = await Promise.all(
    [ownComment, outside, notDownloaded].map(async (filePath) => [filePath, await readFile(filePath)]),
  );
  const untouchedTimes = await Promise.all(untouched.map(([filePath]) => stat(filePath)));

  await processSystemTask({ kind: "identity-marker-migration" });

  for (const filePath of [m4a, mp3, grouped]) {
    const tags = await readTags(filePath);
    assert.equal(tags.grouping, undefined, `${path.basename(filePath)} grouping`);
    assert.deepEqual(await legacyMarkerTagIds(filePath), [], `${path.basename(filePath)} legacy markers`);
    assert.deepEqual(readAurralIdentity(await parseFile(filePath, { skipCovers: true })), ids);
  }
  for (const [index, [filePath, bytes]] of untouched.entries()) {
    assert.deepEqual(await readFile(filePath), bytes, `${path.basename(filePath)} should be untouched`);
    assert.equal((await stat(filePath)).mtimeMs, untouchedTimes[index].mtimeMs);
  }
  assert.deepEqual(
    (({ checked, moved, failed }) => ({ checked, moved, failed }))(dbOps.getJSONSetting("identityMarkerMigration")),
    { checked: 4, moved: 3, failed: 0 },
  );

  await processSystemTask({ kind: "identity-marker-migration" });
  assert.equal(dbOps.getJSONSetting("identityMarkerMigration").moved, 0);
});
