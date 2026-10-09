import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import taglib from "node-taglib-sharp";

import { readAurralIdentity, writeAudioMetadata } from "../../backend/services/downloadUtils.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-audio-tags-"));
const job = {
  trackName: "One More Time",
  artistName: "Daft Punk",
  albumName: "Discovery",
  artistMbid: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
  albumMbid: "48117b90-a16e-34ca-a514-19c702df1158",
  trackMbid: "60fa767a-d85d-4991-82bc-4294e0b11ae7",
  releaseYear: "2001",
  trackNumber: 1,
};

function makeAudio(name, codec) {
  const filePath = path.join(tempDir, name);
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "anullsrc", "-t", "0.2", ...codec, filePath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

function tagAsUploader(filePath, build) {
  const file = taglib.File.createFromPath(filePath);
  build(file);
  file.save();
  file.dispose();
}

const cover = taglib.Picture.fromFullData(
  taglib.ByteVector.fromString("cover-art", taglib.StringType.Latin1),
  taglib.PictureType.FrontCover,
  "image/jpeg",
  "",
);

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("tagging a download keeps the uploader's release ID, ratings, lyrics, ReplayGain, grouping, and cover art", async () => {
  const filePath = makeAudio("uploaded.mp3", ["-c:a", "libmp3lame"]);
  tagAsUploader(filePath, (file) => {
    const id3 = file.getTag(taglib.TagTypes.Id3v2, true);
    file.tag.title = "one more time (album version)";
    file.tag.grouping = "Live set";
    file.tag.musicBrainzTrackId = "99999999-9999-4999-8999-999999999999";
    file.tag.musicBrainzReleaseId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    file.tag.pictures = [cover];
    const rating = taglib.Id3v2PopularimeterFrame.fromUser("listener@example.com");
    rating.rating = 255;
    id3.addFrame(rating);
    const lyrics = taglib.Id3v2UnsynchronizedLyricsFrame.fromData("", "eng");
    lyrics.text = "One more time, we're gonna celebrate";
    id3.addFrame(lyrics);
    const gain = taglib.Id3v2UserTextInformationFrame.fromDescription("REPLAYGAIN_TRACK_GAIN");
    gain.text = ["-6.10 dB"];
    id3.addFrame(gain);
  });

  await writeAudioMetadata(filePath, job);

  const metadata = await parseFile(filePath);
  const { common } = metadata;
  assert.equal(common.title, "One More Time");
  assert.equal(common.musicbrainz_recordingid, job.trackMbid);
  assert.equal(common.musicbrainz_releasegroupid, job.albumMbid);
  assert.equal(common.musicbrainz_albumartistid?.[0], job.artistMbid);
  assert.equal(common.musicbrainz_albumid, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(common.grouping, "Live set");
  assert.equal(common.rating?.[0]?.rating, 1);
  assert.match(common.lyrics?.[0]?.text ?? String(common.lyrics?.[0] ?? ""), /celebrate/);
  assert.equal(common.replaygain_track_gain?.dB, -6.1);
  assert.equal(common.picture?.length, 1);
  assert.equal(metadata.native["ID3v2.4"].filter((tag) => tag.id.startsWith("UFID")).length, 1);
  assert.deepEqual(readAurralIdentity(metadata), {
    artistMbid: job.artistMbid,
    albumMbid: job.albumMbid,
    trackMbid: job.trackMbid,
  });
});

test("tagging an M4A keeps its freeform tags and the tags the job has no value for, and drops a release ID from another album", async () => {
  const filePath = makeAudio("uploaded.m4a", ["-c:a", "aac"]);
  tagAsUploader(filePath, (file) => {
    const apple = file.getTag(taglib.TagTypes.Apple, true);
    apple.setItunesStrings("com.apple.iTunes", "replaygain_track_gain", "-4.20 dB");
    file.tag.musicBrainzReleaseGroupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    file.tag.musicBrainzReleaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    file.tag.musicBrainzTrackId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    file.tag.track = 7;
  });

  await writeAudioMetadata(filePath, { ...job, trackMbid: null, trackNumber: null });

  const { common } = await parseFile(filePath);
  assert.equal(common.musicbrainz_releasegroupid, job.albumMbid);
  assert.equal(common.musicbrainz_albumid, undefined);
  assert.equal(common.musicbrainz_recordingid, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(common.track.no, 7);
  assert.equal(common.replaygain_track_gain?.dB, -4.2);
  assert.equal(common.year, 2001);
});

test("tagging a hardlinked download leaves the other link as it was", async () => {
  const seeding = makeAudio("seeding.flac", []);
  const imported = path.join(tempDir, "imported.flac");
  await link(seeding, imported);
  const seedingBytes = await readFile(seeding);

  await writeAudioMetadata(imported, job);

  assert.deepEqual(await readFile(seeding), seedingBytes);
  assert.notEqual((await stat(seeding)).ino, (await stat(imported)).ino);
  assert.equal((await parseFile(imported)).common.title, "One More Time");
});
