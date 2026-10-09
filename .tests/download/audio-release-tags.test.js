import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFile } from "music-metadata";

import { buildResolvedJobTrack, writeAudioMetadata } from "../../backend/services/downloadUtils.js";

const releaseGroup = "11111111-1111-4111-8111-111111111111";
const release = "22222222-2222-4222-8222-222222222222";

test("writing a known edition replaces the source release ID", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurral-release-tags-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "track.flac");
  const created = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc",
    "-t", "0.05", "-c:a", "flac", "-metadata", `musicbrainz_albumid=${release}`, file,
  ], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  const replacementRelease = "33333333-3333-4333-8333-333333333333";
  const resolvedTrack = buildResolvedJobTrack(
    { albumMbid: releaseGroup },
    { releaseMbid: replacementRelease },
  );
  await writeAudioMetadata(file, resolvedTrack);
  const replaced = await parseFile(file);
  assert.equal(replaced.common.musicbrainz_albumid, replacementRelease);
  assert.equal(replaced.common.musicbrainz_releasegroupid, releaseGroup);
});

test("without a known edition, every track gets the release group ID", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurral-release-tags-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, sourceRelease] of [release, null].entries()) {
    const file = path.join(directory, `track-${index}.flac`);
    const created = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc",
      "-t", "0.05", "-c:a", "flac",
      ...(sourceRelease ? ["-metadata", `musicbrainz_albumid=${sourceRelease}`] : []), file,
    ], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);

    await writeAudioMetadata(file, buildResolvedJobTrack({ albumMbid: releaseGroup }));
    const { common } = await parseFile(file);
    assert.equal(common.musicbrainz_albumid, releaseGroup);
    assert.equal(common.musicbrainz_releasegroupid, releaseGroup);
  }
});
