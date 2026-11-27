import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile, updateFile } from "music-metadata/node";

import { readAudioTags, writeAudioTags } from "../../backend/services/audioTags.ts";
import { readAurralIdentity, writeAudioMetadata } from "../../backend/services/downloadUtils.ts";
import {
  upsertLibraryAlbum,
  upsertLibraryArtist,
} from "../../backend/services/libraryMediaStore.ts";

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

function makeAudio(name: string, codec: string[]) {
  const filePath = path.join(tempDir, name);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc",
      "-t",
      "0.2",
      ...codec,
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("tagging a download keeps the uploader's ratings, lyrics, ReplayGain, grouping, and cover art, but not their release ID", async () => {
  const filePath = makeAudio("uploaded.mp3", ["-c:a", "libmp3lame"]);
  await updateFile(filePath, {
    title: "one more time (album version)",
    grouping: "Live set",
    mbRecordingId: "99999999-9999-4999-8999-999999999999",
    mbReleaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    picture: [{ format: "image/jpeg", data: Buffer.from("cover-art") }],
    rating: [{ source: "listener@example.com", rating: 1 }],
    lyrics: "One more time, we're gonna celebrate",
    native: { "TXXX:REPLAYGAIN_TRACK_GAIN": "-6.10 dB", RVA2: Buffer.from("no identification") },
  });
  await writeAudioMetadata(filePath, job);

  const metadata = await parseFile(filePath);
  const { common } = metadata;
  assert.equal(common.title, "One More Time");
  assert.equal(common.mbRecordingId, job.trackMbid);
  assert.equal(common.mbReleaseGroupId, job.albumMbid);
  assert.equal(common.mbAlbumArtistId?.[0], job.artistMbid);
  assert.equal(common.mbReleaseId, undefined);
  assert.equal(common.grouping, "Live set");
  assert.equal(common.rating?.[0]?.rating, 1);
  assert.match(common.lyrics?.[0]?.text ?? String(common.lyrics?.[0] ?? ""), /celebrate/);
  assert.equal(common.replayGainTrackGain?.dB, -6.1);
  assert.equal(common.picture?.length, 1);
  assert.equal(metadata.native["ID3v2.4"]?.filter((tag) => tag.id.startsWith("UFID")).length, 1);
  assert.deepEqual(readAurralIdentity(metadata), {
    artistMbid: job.artistMbid,
    albumMbid: job.albumMbid,
    trackMbid: job.trackMbid,
  });
});

test("tagging an M4A keeps its freeform tags and the tags the job has no value for, and drops a release ID from another album", async () => {
  const filePath = makeAudio("uploaded.m4a", ["-c:a", "aac"]);
  await updateFile(filePath, {
    native: { "----:com.apple.iTunes:replaygain_track_gain": "-4.20 dB" },
    mbReleaseGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mbReleaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mbRecordingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    track: { no: 7 },
  });
  await writeAudioMetadata(filePath, { ...job, trackMbid: null, trackNumber: null });

  const { common } = await parseFile(filePath);
  assert.equal(common.mbReleaseGroupId, job.albumMbid);
  assert.equal(common.mbReleaseId, undefined);
  assert.equal(common.mbRecordingId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(common.trackNumber, 7);
  assert.equal(common.replayGainTrackGain?.dB, -4.2);
  assert.equal(common.year, 2001);
});

test("tracks from uploaders of different releases get the one release Aurral picked for the album", async () => {
  const releaseMbid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const uploads = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const files = await Promise.all(
    uploads.map(async (uploaderRelease, index) => {
      const filePath = makeAudio(`disc-${index}.flac`, ["-c:a", "flac"]);
      await updateFile(filePath, {
        mbReleaseGroupId: job.albumMbid,
        mbReleaseId: uploaderRelease,
      });
      return filePath;
    }),
  );
  for (const filePath of files) await writeAudioMetadata(filePath, { ...job, releaseMbid });

  for (const filePath of files) {
    assert.equal((await parseFile(filePath)).common.mbReleaseId, releaseMbid);
  }
});

test("a download for an album without a release group is tagged with its release, never as a release group", async () => {
  const releaseMbid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const artist = upsertLibraryArtist({ identityKey: `mbid:${job.artistMbid}`, name: "Daft Punk" });
  upsertLibraryAlbum({
    identityKey: `album:${releaseMbid}`,
    mbid: releaseMbid,
    artistId: artist.id,
    title: "Discovery",
  });
  const filePath = makeAudio("groupless.flac", ["-c:a", "flac"]);
  await updateFile(filePath, {
    mbReleaseGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mbReleaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });

  await writeAudioMetadata(filePath, { ...job, albumMbid: releaseMbid });

  const metadata = await parseFile(filePath);
  assert.equal(metadata.common.mbReleaseGroupId, undefined);
  assert.equal(metadata.common.mbReleaseId, releaseMbid);
  assert.equal(readAurralIdentity(metadata)?.albumMbid, undefined);
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

test("FLAC identity migration preserves each surviving native comment and description", async () => {
  const file = makeAudio("legacy-identity.flac", ["-c:a", "flac"]);
  const marker = 'AURRAL_IDS={"trackMbid":"old"}';
  const comments = ["Shared", "Comment only"];
  const descriptions = ["Shared", " Description only "];
  await updateFile(file, {
    native: { COMMENT: [marker, ...comments], DESCRIPTION: [...descriptions, marker] },
  });

  const identity = { trackMbid: "new", albumMbid: "album" };
  await writeAudioTags(file, {}, { identity });
  const saved = await parseFile(file);
  const values = (id: string) =>
    saved.native.vorbis?.filter((tag) => tag.id === id).map((tag) => tag.value);
  assert.deepEqual(values("COMMENT"), comments);
  assert.deepEqual(values("DESCRIPTION"), descriptions);
  assert.deepEqual(readAurralIdentity(saved), identity);
  const bytes = await readFile(file);
  const before = await stat(file, { bigint: true });
  await writeAudioTags(file, {}, { identity: { albumMbid: "album", trackMbid: "new" } });
  assert.equal((await stat(file, { bigint: true })).ino, before.ino);
  assert.deepEqual(await readFile(file), bytes);
});

test("WMA artist lists use WM/ARTISTS and preserve the display credit", async () => {
  const file = makeAudio("credits.wma", ["-c:a", "wmav2"]);
  const artist = "A feat. B";
  const artists = ["A", "B"];
  await updateFile(file, { artist, native: { ARTISTS: ["Old name"] } });
  assert.deepEqual((await readAudioTags(file)).artists, ["Old name"]);
  await writeAudioTags(file, { artists });
  const saved = await parseFile(file);
  assert.equal(saved.common.artist, artist);
  assert.deepEqual(saved.common.artists, artists);
  assert.ok(!saved.native.asf?.some((tag) => tag.id.toUpperCase() === "ARTISTS"));
  assert.deepEqual((await readAudioTags(file)).artists, artists);
  assert.deepEqual(await writeAudioTags(file, { artists }), []);
});

test.each([
  ["M4A", "credits.m4a", ["-c:a", "aac"]],
  ["Ogg Vorbis", "credits.ogg", ["-c:a", "libvorbis"]],
  ["FLAC", "credits.flac", ["-c:a", "flac"]],
  ["MP3", "credits.mp3", ["-c:a", "libmp3lame"]],
])("%s keeps the display credit while the artist list is replaced", async (_name, name, codec) => {
  const file = makeAudio(name, codec);
  const artist = "A feat. B";
  await updateFile(file, { artist, artists: ["A", "Old name"] });
  assert.deepEqual((await readAudioTags(file)).artists, ["A", "Old name"]);

  assert.deepEqual(await writeAudioTags(file, { artists: ["A", "B"] }), ["artists"]);
  const saved = (await parseFile(file)).common;
  assert.equal(saved.artist, artist);
  assert.deepEqual(saved.artists, ["A", "B"]);
  assert.deepEqual(await writeAudioTags(file, { artists: ["A", "B"] }), []);

  await updateFile(file, { artist: "A", artists: ["A"] });
  assert.deepEqual((await readAudioTags(file)).artists, ["A"]);
  await updateFile(file, { artists: null });
  assert.deepEqual((await readAudioTags(file)).artists, []);
});

test("an ID3v2.3 download upgrades through common tags without losing artwork, ReplayGain, lyrics, ratings, custom TXXX tags, or audio", async () => {
  const filePath = makeAudio("legacy.mp3", ["-c:a", "libmp3lame", "-id3v2_version", "0"]);
  const audio = await readFile(filePath);
  const cover = Buffer.from("cover-art");
  const originalIdentity = { trackMbid: "original-recording" };
  const textFrame = (text: string) =>
    Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
  const utf16Frame = (text: string) =>
    Buffer.concat([Buffer.from([1]), Buffer.from(`\uFEFF${text}`, "utf16le")]);
  const frame = (id: string, body: Buffer) => {
    const header = Buffer.alloc(10);
    header.write(id);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const body = Buffer.concat([
    frame("TIT2", textFrame("Original")),
    frame("TALB", textFrame("Uploader's album")),
    frame("TPE1", textFrame("Uploader")),
    frame("TPE2", utf16Frame("Proxy\0\uFEFF\0\uFEFF")),
    frame("TRCK", textFrame("7/12")),
    frame("TPOS", textFrame("1/2")),
    frame("TYER", textFrame("1999")),
    frame("TXXX", textFrame(`AURRAL_IDS\0${JSON.stringify(originalIdentity)}`)),
    frame("TXXX", textFrame("MusicBrainz Album Id\0dddddddd-dddd-4ddd-8ddd-dddddddddddd")),
    frame("TXXX", textFrame("ROONTRACKTAG\0Favorite")),
    frame("TXXX", textFrame("ROONTRACKTAG\0Late Night")),
    frame("TXXX", textFrame("REPLAYGAIN_TRACK_GAIN\0-6.10 dB")),
    frame("TXXX", textFrame("REPLAYGAIN_ALBUM_GAIN\0-4.20 dB")),
    frame("TXXX", textFrame("REPLAYGAIN_TRACK_PEAK\0" + "0.91")),
    frame("USLT", Buffer.concat([Buffer.from([0]), Buffer.from("englyrics\0One more time")])),
    frame("COMM", Buffer.concat([Buffer.from([0]), Buffer.from("engnotes\0Keep this comment")])),
    frame(
      "APIC",
      Buffer.concat([Buffer.from([0]), Buffer.from("image/jpeg\0"), Buffer.from([3, 0]), cover]),
    ),
    frame(
      "POPM",
      Buffer.concat([Buffer.from("listener@example.com\0"), Buffer.from([255, 0, 0, 0, 42])]),
    ),
  ]);
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  header[6] = (body.length >>> 21) & 127;
  header[7] = (body.length >>> 14) & 127;
  header[8] = (body.length >>> 7) & 127;
  header[9] = body.length & 127;
  await writeFile(filePath, Buffer.concat([header, body, audio]));
  const before = await parseFile(filePath);
  const originalBytes = await readFile(filePath);
  const originalStat = await stat(filePath, { bigint: true });
  assert.deepEqual(await writeAudioTags(filePath, { title: "Original" }), []);
  assert.deepEqual(await readFile(filePath), originalBytes);
  assert.equal((await stat(filePath, { bigint: true })).mtimeNs, originalStat.mtimeNs);

  // Planning validates the same conversion without changing anything on disk.
  assert.equal((await readAudioTags(filePath)).title, "Original");
  assert.deepEqual(await readFile(filePath), originalBytes);
  await writeAudioMetadata(filePath, job);

  const after = await parseFile(filePath);
  assert.ok(after.native["ID3v2.4"]);
  assert.equal(after.common.title, job.trackName);
  assert.equal(after.common.album, job.albumName);
  assert.equal(after.common.year, 2001);
  assert.equal(after.common.trackNumber, 1);
  assert.equal(after.common.trackTotal, 12);
  assert.equal(after.common.discTotal, 2);
  assert.equal(after.common.mbReleaseId, undefined);
  assert.deepEqual(
    after.native["ID3v2.4"]
      ?.filter((tag) => tag.id === "TXXX:ROONTRACKTAG")
      .map((tag) => tag.value),
    ["Favorite", "Late Night"],
  );
  for (const key of [
    "picture",
    "lyrics",
    "comments",
    "rating",
    "replayGainTrackGain",
    "replayGainAlbumGain",
    "replayGainTrackPeak",
  ] as const)
    assert.deepEqual(after.common[key], before.common[key], key);
  assert.deepEqual(after.common.picture?.[0]?.data, new Uint8Array(cover));
  assert.deepEqual(
    after.native["ID3v2.4"]?.find((tag) => tag.id === "POPM")?.value,
    before.native["ID3v2.3"]?.find((tag) => tag.id === "POPM")?.value,
  );
  assert.equal(readAurralIdentity(after)?.trackMbid, job.trackMbid);
  assert.deepEqual((await readFile(filePath)).subarray(-audio.length), audio);

  const titleOnly = path.join(tempDir, "legacy-title-only.mp3");
  await writeFile(titleOnly, originalBytes);
  assert.deepEqual(await writeAudioTags(titleOnly, { title: "Corrected" }), ["title"]);
  const corrected = await parseFile(titleOnly);
  assert.equal(corrected.common.title, "Corrected");
  assert.equal(corrected.common.albumArtist, "Proxy");
  assert.deepEqual(
    corrected.native["ID3v2.4"]
      ?.filter((tag) => tag.id === "TXXX:ROONTRACKTAG")
      .map((tag) => tag.value),
    ["Favorite", "Late Night"],
  );
  assert.deepEqual(readAurralIdentity(corrected), originalIdentity);
  assert.deepEqual(corrected.common.picture, before.common.picture);
  assert.deepEqual((await readFile(titleOnly)).subarray(-audio.length), audio);

  const v22Path = path.join(tempDir, "legacy-v22.mp3");
  const frame22 = (id: string, data: Buffer) => {
    const frameHeader = Buffer.alloc(6);
    frameHeader.write(id);
    frameHeader[3] = (data.length >>> 16) & 0xff;
    frameHeader[4] = (data.length >>> 8) & 0xff;
    frameHeader[5] = data.length & 0xff;
    return Buffer.concat([frameHeader, data]);
  };
  const body22 = Buffer.concat([
    frame22("TT2", textFrame("Old V22")),
    frame22("TP1", textFrame("Old Artist")),
    frame22("TXX", textFrame(`AURRAL_IDS\0${JSON.stringify(originalIdentity)}`)),
    frame22("TXX", textFrame("CUSTOM_V22\0Keep this")),
    frame22("TXX", textFrame("REPLAYGAIN_TRACK_GAIN\0-5.10 dB")),
    frame22("TXX", textFrame("MusicBrainz Artist Id\0" + "11111111-1111-4111-8111-111111111111")),
    frame22("TXX", textFrame("MusicBrainz Album Id\0dddddddd-dddd-4ddd-8ddd-dddddddddddd")),
  ]);
  const header22 = Buffer.from([73, 68, 51, 2, 0, 0, 0, 0, 0, 0]);
  header22[6] = (body22.length >>> 21) & 127;
  header22[7] = (body22.length >>> 14) & 127;
  header22[8] = (body22.length >>> 7) & 127;
  header22[9] = body22.length & 127;
  await writeFile(v22Path, Buffer.concat([header22, body22, audio]));
  assert.equal((await readAudioTags(v22Path)).title, "Old V22");
  assert.deepEqual(
    await writeAudioTags(v22Path, {
      title: "New V22",
      artistMbid: [job.artistMbid],
      releaseGroupMbid: job.albumMbid,
    }),
    ["title", "artistMbid", "releaseGroupMbid"],
  );
  const saved22 = await parseFile(v22Path);
  assert.ok(saved22.native["ID3v2.4"]);
  assert.equal(saved22.common.title, "New V22");
  assert.equal(saved22.common.artist, "Old Artist");
  assert.equal(saved22.common.replayGainTrackGain?.dB, -5.1);
  assert.deepEqual(saved22.common.mbArtistId, [job.artistMbid]);
  assert.equal(saved22.common.mbReleaseGroupId, job.albumMbid);
  assert.equal(saved22.common.mbReleaseId, undefined);
  assert.deepEqual(readAurralIdentity(saved22), originalIdentity);
  assert.deepEqual(
    saved22.native["ID3v2.4"]
      ?.filter((tag) => tag.id === "TXXX:CUSTOM_V22")
      .map((tag) => tag.value),
    ["Keep this"],
  );
  assert.deepEqual((await readFile(v22Path)).subarray(-audio.length), audio);
});

test("tagging a fragmented M4A leaves the file as it was instead of breaking its audio", async () => {
  const filePath = makeAudio("fragmented.m4a", [
    "-c:a",
    "aac",
    "-movflags",
    "frag_keyframe+empty_moov",
  ]);
  const bytes = await readFile(filePath);

  await assert.rejects(writeAudioMetadata(filePath, job), { code: "TAGS_UNSUPPORTED" });

  assert.deepEqual(await readFile(filePath), bytes);
});
