import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import {
  getLibrary,
  getLibraryPage,
  getLibraryTrackOwnership,
  getLibraryTrackOwnershipBatch,
} from "../../backend/services/libraryQueryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

test("track performer stays distinct from the album owner without changing audio tags", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-performer-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Owner", "Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Owner", artist: "Guest & Owner", album: "Album", title: "Song" };

  await scanMusicRoot({ rootPath: root, metadataReader: async () => ({ common }) });

  const library = getLibrary({ availableOnly: true });
  const track = library.tracks.find((entry) => entry.files.some((entry) => entry.path === file));
  assert.equal(track.artistName, "Guest & Owner");
  assert.equal(library.albums.find((album) => album.trackIds.includes(track.id))?.albumArtist, "Owner");
  assert.equal(await readFile(file, "utf8"), "original audio");
});

test("scanned featured tracks are owned by both their performer and album owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-featured-ownership-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "01.flac");
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
    "-metadata", "album_artist=Ownership Owner", "-metadata", "artist=Ownership Owner feat. Guest",
    "-metadata", "album=Featured Ownership", "-metadata", "title=Featured Song",
    "-metadata", "MUSICBRAINZ_TRACKID=22222222-2222-4222-8222-222222222222", file,
  ]);
  const original = await readFile(file);
  const scan = await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(scan.filesIndexed, 1);
  const track = getLibrary({ availableOnly: true }).tracks
    .find((entry) => entry.files.some((entry) => entry.path === file));
  assert.equal(track.artistName, "Ownership Owner feat. Guest");
  assert.equal(track.mbid, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(await readFile(file), original);

  const references = [
    { artistName: "Ownership Owner", trackName: "Featured Song" },
    { artistName: "Ownership Owner feat. Guest", trackName: "Featured Song" },
    { artistName: " ownership owner ", trackName: " featured song " },
    { artistName: "Another Artist", trackName: "Featured Song" },
    { artistName: "Ownership Owner", trackName: "Missing Song" },
    { trackMbid: "22222222-2222-4222-8222-222222222222", artistName: "Another Artist", trackName: "Another Song" },
    { trackMbid: "33333333-3333-4333-8333-333333333334", artistName: "Ownership Owner", trackName: "Featured Song" },
    { artistName: "Ownership Owner" },
    {},
    null,
    { artistName: "Ownership Owner", trackName: "Featured Song" },
  ];
  const expected = [true, true, true, false, false, true, false, false, false, false, true];
  assert.deepEqual(references.map((reference) => getLibraryTrackOwnership(reference || {})), expected);
  assert.deepEqual(getLibraryTrackOwnershipBatch(references), expected);
  assert.deepEqual(references.map((reference) => getLibraryTrackOwnership({ ...reference, source: "aurral" })), expected);
  assert.deepEqual(getLibraryTrackOwnershipBatch(references, { source: "aurral" }), expected);
  const unavailable = [false, false, false, false, false, false, false, false, false, false, false];
  assert.deepEqual(references.map((reference) => getLibraryTrackOwnership({ ...reference, source: "lidarr" })), unavailable);
  assert.deepEqual(getLibraryTrackOwnershipBatch(references, { source: "lidarr" }), unavailable);

  await rm(file);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.deepEqual(references.map((reference) => getLibraryTrackOwnership(reference || {})), unavailable);
  assert.deepEqual(getLibraryTrackOwnershipBatch(references), unavailable);
});

test("rescanning updates a local title when its normalized identity stays the same", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-title-rescan-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Title Artist", "Title Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Title Artist", artist: "Title Artist", album: "Title Album", title: "Pret", track: { no: 1 } };
  const scan = () => scanMusicRoot({ rootPath: root, force: true,
    metadataReader: async () => ({ common }) });
  const readTrack = () => getLibrary({ availableOnly: true }).tracks
    .find((track) => track.files.some((entry) => entry.path === file));
  await scan();
  const before = readTrack();
  common.title = "Prêt";

  await scan();

  const after = readTrack();
  assert.equal(after.id, before.id);
  assert.equal(after.identityKey, before.identityKey);
  assert.equal(after.title, "Prêt");
  assert.equal(after.metadata.tags.title, "Prêt");
});

test("reused canonical tracks refresh performer tags without replacing identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-canonical-performer-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Canonical Owner", "Canonical Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Canonical Owner", artist: "Original Guest", album: "Canonical Album",
    title: "Prêt", track: { no: 1 }, musicbrainz_recordingid: "11111111-1111-4111-8111-111111111111" };
  const scan = () => scanMusicRoot({ rootPath: root, force: true,
    metadataReader: async () => ({ common }) });
  const readTrack = () => getLibrary({ availableOnly: true }).tracks
    .find((track) => track.files.some((entry) => entry.path === file));
  await scan();
  const before = readTrack();
  upsertLibraryTrack({ identityKey: before.identityKey, mbid: before.mbid, title: before.title,
    artistName: before.artistName, metadata: { ...before.metadata, canonicalSource: "catalogue" } });
  delete common.musicbrainz_recordingid;
  common.artist = "Corrected Guest";
  common.title = "Pret";

  await scan();

  const after = readTrack();
  assert.equal(after.id, before.id);
  assert.equal(after.identityKey, before.identityKey);
  assert.equal(after.mbid, "11111111-1111-4111-8111-111111111111");
  assert.equal(after.title, "Prêt");
  assert.equal(after.artistName, "Corrected Guest");
  assert.equal(after.metadata.tags.artist, "Corrected Guest");
  assert.equal(after.metadata.tags.title, "Pret");
  assert.equal(after.metadata.canonicalSource, "catalogue");

  delete common.artist;
  await scan();

  const withoutPerformerTag = readTrack();
  assert.equal(withoutPerformerTag.id, before.id);
  assert.equal(withoutPerformerTag.artistName, "Corrected Guest");
});

test("a track whose files credit different performers keeps one credit whatever the scan order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-performer-order-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const files = ["a.mp3", "b.mp3"].map((name) => path.join(root, "Order Owner", "Order Album", name));
  await mkdir(path.dirname(files[0]), { recursive: true });
  for (const file of files) await writeFile(file, "audio");
  const credits = new Map([[files[0], "Order Owner feat. First"], [files[1], "Order Owner feat. Second"]]);
  const scan = (filePaths) => scanMusicRoot({ rootPath: root, filePaths, force: true,
    metadataReader: async (filePath) => ({ common: { albumartist: "Order Owner", artist: credits.get(filePath),
      album: "Order Album", title: "Order Song", track: { no: 1 } } }) });
  const tracks = () => getLibrary({ availableOnly: true }).tracks
    .filter((track) => track.files.some((file) => files.includes(file.path)));

  await scan(files);
  assert.deepEqual(tracks().map((track) => [track.files.length, track.artistName]), [[2, "Order Owner feat. First"]]);

  await scan([...files].reverse());
  assert.deepEqual(tracks().map((track) => [track.files.length, track.artistName]), [[2, "Order Owner feat. First"]]);
});

test("a recording keeps its performer when a rescan finds no artist tag", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-performer-mbid-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Mbid Owner", "Mbid Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "audio");
  const common = { albumartist: "Mbid Owner", artist: "Mbid Owner feat. Guest", album: "Mbid Album",
    title: "Mbid Song", track: { no: 1 }, musicbrainz_recordingid: "44444444-4444-4444-8444-444444444444" };
  const scan = () => scanMusicRoot({ rootPath: root, force: true, metadataReader: async () => ({ common }) });
  const readTrack = () => getLibrary({ availableOnly: true }).tracks
    .find((track) => track.files.some((entry) => entry.path === file));
  await scan();
  delete common.artist;

  await scan();

  assert.equal(readTrack().artistName, "Mbid Owner feat. Guest");
});

test("a tagged performer beats files without an artist tag whatever the scan order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-performer-untagged-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const credits = { "a.mp3": undefined, "b.flac": "Untagged Owner feat. Guest", "c.mp3": "Untagged Owner feat. Other" };
  const orders = [["a.mp3", "b.flac"], ["b.flac", "a.mp3"], ["a.mp3", "c.mp3", "b.flac"], ["c.mp3", "a.mp3", "b.flac"]];
  for (const [index, order] of orders.entries()) {
    const files = order.map((name) => path.join(root, `Album ${index}`, name));
    await mkdir(path.dirname(files[0]), { recursive: true });
    for (const file of files) await writeFile(file, "audio");
    const scan = (filePaths) => scanMusicRoot({ rootPath: root, filePaths, force: true,
      metadataReader: async (filePath) => ({ common: { albumartist: "Untagged Owner",
        artist: credits[path.basename(filePath)], album: `Album ${index}`, title: "Song", track: { no: 1 } } }) });
    const tracks = () => getLibrary({ availableOnly: true }).tracks
      .filter((track) => track.files.some((file) => files.includes(file.path)))
      .map((track) => [track.files.length, track.artistName]);

    await scan(files.slice(0, 1));
    const firstCredit = credits[order[0]] || "Untagged Owner";
    assert.deepEqual(tracks(), [[1, firstCredit]], order.join(", "));
    await scan(files.slice(1));
    assert.deepEqual(tracks(), [[files.length, credits["b.flac"]]], order.join(", "));
    await scan([...files].reverse());
    assert.deepEqual(tracks(), [[files.length, credits["b.flac"]]], order.join(", "));
  }
});

for (const scope of ["library", "album"]) {
  test(`${scope} track pages sort by performer before pagination, falling back to the album owner`, () => {
    const artist = upsertLibraryArtist({ identityKey: `sort:${scope}:artist`, name: "Sort Owner" });
    const album = upsertLibraryAlbum({ identityKey: `sort:${scope}:album`, artistId: artist.id, title: "Sort Album" });
    for (const [index, [title, artistName]] of [
      ["A guest song", "Guest"], ["Z alpha song", "Alpha"], ["M owner song", null],
    ].entries()) {
      const track = upsertLibraryTrack({ identityKey: `sort:${scope}:track:${index}`, title, artistName });
      linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
      upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral",
        path: `/fixture/sort-${scope}/${index}.flac`, available: true });
    }
    const filter = scope === "album" ? { albumId: album.id } : { artistId: artist.id };
    const titles = (direction) => [1, 2, 3].map((page) => getLibraryPage({ kind: "tracks",
      ...filter, sort: "artist", direction, page, pageSize: 1 }).items[0]?.title);

    assert.deepEqual(titles("asc"), ["Z alpha song", "A guest song", "M owner song"]);
    assert.deepEqual(titles("desc"), ["M owner song", "A guest song", "Z alpha song"]);
  });
}
