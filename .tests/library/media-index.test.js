import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import {
  getLibraryArtistProjection,
  getLibrary,
  getLibraryIndexLastModified,
  getLibraryPage,
  getLibrarySearchPage,
  invalidateLibraryQueryCache,
} from "../../backend/services/libraryQueryService.js";
import {
  buildFallbackIdentityKey,
  linkLibraryAlbumTrack,
  removeLibraryTrackIfNoAvailableMedia,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "../../backend/services/libraryMediaStore.js";
import {
  createPathScopeMatcher,
  scanMusicRoot,
  scanMusicRoots,
} from "../../backend/services/libraryFileScanner.js";
import { scanConfiguredLibrary } from "../../backend/services/libraryIndexService.js";
import { setLibraryManagement } from "../../backend/services/libraryManagementStore.js";
import { dbOps } from "../../backend/db/helpers/index.js";
import { clearMetadataProviderCaches } from "../../backend/services/providers/brainzmashProvider.js";
import { createMockHttpServer } from "../helpers/backendTestHarness.js";

const getLibrarySnapshot = () => ({
  artists: db.prepare("SELECT * FROM library_artists ORDER BY name").all(),
  albums: db.prepare("SELECT * FROM library_albums ORDER BY title").all(),
  tracks: db.prepare("SELECT * FROM library_tracks ORDER BY title").all(),
  files: db.prepare("SELECT * FROM library_media_files ORDER BY path").all(),
});

test("scan change tracking ignores unrelated database writes", async () => {
  const settingKey = `unrelated-scan-write-${process.pid}`;
  try {
    const result = await withLibraryScan("test-unrelated-write", null, async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(settingKey, "value");
      return { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    });

    assert.equal(result.changed, false);
  } finally {
    db.prepare("DELETE FROM settings WHERE key = ?").run(settingKey);
    db.prepare("DELETE FROM library_scan_runs WHERE source = 'test-unrelated-write'").run();
  }
});

test("overlapping scans keep change tracking isolated", async () => {
  const identityKey = `name:overlapping-scan-${process.pid}`;
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstChanged;

  try {
    const first = withLibraryScan("test-overlap-first", null, async () => {
      upsertLibraryArtist({ identityKey, name: "Overlapping Scan", syncSearch: false });
      firstChanged = true;
      await holdFirst;
      return { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    });
    while (!firstChanged) await new Promise((resolve) => setImmediate(resolve));

    const second = await withLibraryScan("test-overlap-second", null, async () => (
      { filesSeen: 0, filesIndexed: 0, filesFailed: 0 }
    ));
    releaseFirst();

    assert.equal(second.changed, false);
    assert.equal((await first).changed, true);
  } finally {
    releaseFirst?.();
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(identityKey);
    db.prepare("DELETE FROM library_scan_runs WHERE source LIKE 'test-overlap-%'").run();
  }
});

test("a failed scan-run insert does not leak scan state", async () => {
  const identityKey = `name:scan-insert-failure-${process.pid}`;
  let artist;
  try {
    artist = upsertLibraryArtist({ identityKey, name: "Before Failure", syncSearch: false });
    const album = upsertLibraryAlbum({
      identityKey: `${identityKey}:album`,
      artistId: artist.id,
      title: "Scan Failure Album",
      syncSearch: false,
    });
    const track = upsertLibraryTrack({
      identityKey: `${identityKey}:track`,
      title: "Scan Failure Track",
      artistName: "Before Failure",
      syncSearch: false,
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, syncSearch: false });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/scan-insert-failure-${process.pid}.flac`,
      available: true,
    });
    assert.equal(getLibrary().artists.find((item) => item.id === artist.id)?.name, "Before Failure");

    db.exec(`CREATE TEMP TRIGGER fail_library_scan_insert
      BEFORE INSERT ON library_scan_runs BEGIN
        SELECT RAISE(FAIL, 'scan insert failed');
      END`);
    await assert.rejects(
      () => withLibraryScan("test-insert-failure", null, async () => ({})),
      /scan insert failed/,
    );
    db.exec("DROP TRIGGER fail_library_scan_insert");

    await withLibraryScan("test-after-insert-failure", null, async () => {
      upsertLibraryArtist({ identityKey, name: "After Failure", syncSearch: false });
      return { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    });

    assert.equal(getLibrary().artists.find((item) => item.id === artist.id)?.name, "After Failure");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_library_scan_insert");
    if (artist) db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    db.prepare("DELETE FROM library_scan_runs WHERE source LIKE 'test-%insert-failure'").run();
    invalidateLibraryQueryCache();
  }
});

test("a local-only configured scan does not contact Lidarr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-local-only-scan-"));
  let lidarrCalls = 0;
  try {
    const result = await scanConfiguredLibrary({
      musicRoot: root,
      includeLidarr: false,
      lidarrClient: {
        isConfigured: () => true,
        request: async () => {
          lidarrCalls += 1;
          throw new Error("unexpected Lidarr request");
        },
      },
    });
    assert.equal(lidarrCalls, 0);
    assert.equal(result.lidarr.skipped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root scans ignore empty root values instead of scanning the process directory", async () => {
  const source = `empty-root-scan-${process.pid}-${Date.now()}`;
  try {
    const result = await scanMusicRoots({
      rootPaths: ["", "  ", null],
      source,
      syncSearch: false,
    });

    assert.deepEqual(result, { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM library_scan_runs WHERE source = ?").get(source).count,
      0,
    );
  } finally {
    db.prepare("DELETE FROM library_scan_runs WHERE source = ?").run(source);
  }
});

test("a configured scan does not contact Lidarr without discovered roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-failed-index-repair-"));
  const identityKey = `name:failed-index-repair-${process.pid}`;
  const artist = upsertLibraryArtist({
    identityKey,
    name: "Failed Index Repair",
    syncSearch: false,
  });
  db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
    .run(artist.id);

  try {
    const result = await scanConfiguredLibrary({
      musicRoot: root,
      lidarrClient: {
        isConfigured: () => true,
        isEnabled: () => true,
        request: async () => {
          throw new Error("unexpected Lidarr request");
        },
      },
    });

    assert.equal(result.lidarr.skipped, true);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(identityKey);
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Lidarr roots scan locally and reconcile only those roots", async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), "aurral-local-lidarr-root-one-")),
    mkdtemp(path.join(tmpdir(), "aurral-local-lidarr-root-two-")),
  ]);
  const paths = await Promise.all([
    createAudioFile(roots[0], "Local Artist/Local Album/01 Local Track.flac"),
    createAudioFile(roots[1], "Local Artist/Local Album/02 Local Track.flac"),
  ]);
  const outsidePath = path.join(tmpdir(), `aurral-local-lidarr-outside-${process.pid}.flac`);
  const scanMetadata = {
    ...metadata,
    common: {
      ...metadata.common,
      albumartist: `Local Artist ${process.pid}`,
      artist: `Local Artist ${process.pid}`,
      album: `Local Album ${process.pid}`,
      title: `Local Track ${process.pid}`,
      musicbrainz_albumartistid: `11111111-1111-4111-8111-${String(process.pid).padStart(12, "0")}`,
      musicbrainz_releasegroupid: `22222222-2222-4222-8222-${String(process.pid).padStart(12, "0")}`,
      musicbrainz_recordingid: `33333333-3333-4333-8333-${String(process.pid).padStart(12, "0")}`,
    },
  };
  let trackId;
  try {
    const result = await scanMusicRoots({
      rootPaths: roots,
      source: "lidarr",
      metadataReader: async () => scanMetadata,
      syncSearch: false,
    });
    assert.equal(result.filesIndexed, 2);
    trackId = getLibrarySnapshot().tracks.find((track) => track.title === scanMetadata.common.title)?.id;
    upsertLibraryMediaFile({
      trackId,
      source: "lidarr",
      path: outsidePath,
      available: true,
    });

    await rm(paths[0]);
    const rescanned = await scanMusicRoots({
      rootPaths: roots,
      source: "lidarr",
      metadataReader: async () => scanMetadata,
      syncSearch: false,
    });
    const snapshot = getLibrarySnapshot();
    assert.equal(rescanned.filesIndexed, 1);
    assert.equal(snapshot.files.find((file) => file.path === paths[0])?.available, 0);
    assert.equal(snapshot.files.find((file) => file.path === outsidePath)?.available, 1);
  } finally {
    const albumIds = trackId
      ? db.prepare("SELECT album_id FROM library_album_tracks WHERE track_id = ?").all(trackId)
        .map((row) => row.album_id)
      : [];
    const artistIds = albumIds.length
      ? db.prepare(`SELECT artist_id FROM library_albums WHERE id IN (${albumIds.map(() => "?").join(",")})`)
        .all(...albumIds)
        .map((row) => row.artist_id)
      : [];
    db.prepare("DELETE FROM library_media_files WHERE path IN (?, ?, ?)").run(
      ...paths,
      outsidePath,
    );
    if (trackId) {
      db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(trackId);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(trackId);
    }
    if (albumIds.length) {
      db.prepare(`DELETE FROM library_albums WHERE id IN (${albumIds.map(() => "?").join(",")})`).run(...albumIds);
    }
    if (artistIds.length) {
      db.prepare(`DELETE FROM library_artists WHERE id IN (${artistIds.map(() => "?").join(",")})`).run(...artistIds);
    }
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

const lidarrOn = { isConfigured: () => true };
const lidarrOff = { isConfigured: () => false };

const albumByTitle = (title) => db.prepare(
  `SELECT album.*, management.managed_by, management.monitor_mode
   FROM library_albums AS album
   LEFT JOIN library_management AS management
     ON management.entity_kind = 'album' AND management.entity_id = album.id
   WHERE album.title = ?`,
).get(title);

const albumTrackTitles = (albumId) => db.prepare(
  `SELECT track.title FROM library_album_tracks AS link
   JOIN library_tracks AS track ON track.id = link.track_id
   WHERE link.album_id = ? ORDER BY track.title`,
).pluck().all(albumId);

const mediaSources = (filePath) => db.prepare(
  "SELECT source FROM library_media_files WHERE path = ? ORDER BY source",
).pluck().all(filePath);

const removeArtistsNamed = (pattern) =>
  db.prepare("DELETE FROM library_artists WHERE name LIKE ?").run(pattern);

test("turning Lidarr off removes its music from the Library and keeps Aurral's", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-off-downloads-"));
  const music = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-off-music-"));
  const tag = `Off ${process.pid}`;
  t.after(async () => {
    removeArtistsNamed(`${tag}%`);
    await rm(downloads, { recursive: true, force: true });
    await rm(music, { recursive: true, force: true });
  });
  const lidarrOnly = await createAudioFile(music, `${tag} Lidarr/${tag} Only/01 Only.flac`);
  const sharedSingle = await createAudioFile(downloads, `${tag} Shared/${tag} Shared/01 Single.flac`);
  const sharedLidarr = await createAudioFile(music, `${tag} Shared/${tag} Shared/02 Rest.flac`);
  const requestedAurral = await createAudioFile(downloads, `${tag} Requested/${tag} Requested/01 Have.flac`);
  await createAudioFile(music, `${tag} Requested/${tag} Requested/02 Want.flac`);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });

  assert.equal(albumByTitle(`${tag} Only`).managed_by, "lidarr");
  assert.equal(albumByTitle(`${tag} Shared`).managed_by, "lidarr");
  const requested = albumByTitle(`${tag} Requested`);
  db.prepare("UPDATE library_management SET managed_by = 'aurral' WHERE entity_kind = 'album' AND entity_id = ?")
    .run(requested.id);
  db.prepare("UPDATE library_albums SET metadata_json = json_set(metadata_json, '$.trackListComplete', json('true')) WHERE id = ?")
    .run(requested.id);
  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });
  assert.equal(albumByTitle(`${tag} Requested`).managed_by, "aurral");
  const wanted = upsertLibraryAlbum({
    identityKey: `${tag}:wanted`,
    artistId: albumByTitle(`${tag} Only`).artist_id,
    title: `${tag} Wanted`,
    metadata: { librarySource: "lidarr", foreignAlbumId: "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b", monitored: true },
    syncSearch: false,
  });
  const wantedTrack = upsertLibraryTrack({ identityKey: `${tag}:wanted:track`, title: "Wanted Song", syncSearch: false });
  linkLibraryAlbumTrack({ albumId: wanted.id, trackId: wantedTrack.id, trackNumber: 1, syncSearch: false });
  setLibraryManagement({ entityKind: "album", entityId: wanted.id, managedBy: "lidarr" });
  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });
  assert.equal(albumByTitle(`${tag} Wanted`).managed_by, "lidarr");

  const off = await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOff, lidarrRoots: [music] });

  assert.equal(off.lidarrRemoved, true);
  assert.equal(albumByTitle(`${tag} Only`), undefined);
  assert.equal(albumByTitle(`${tag} Wanted`), undefined);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM library_artists WHERE name = ?").get(`${tag} Lidarr`).count,
    0,
  );
  const shared = albumByTitle(`${tag} Shared`);
  assert.equal(shared.managed_by, "aurral");
  assert.equal(shared.monitor_mode, null);
  assert.deepEqual(albumTrackTitles(shared.id), ["Single"]);
  assert.deepEqual(albumTrackTitles(requested.id), ["Have", "Want"]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM library_media_files WHERE source = 'lidarr'").get().count,
    0,
  );
  assert.deepEqual(mediaSources(sharedSingle), ["aurral"]);
  assert.deepEqual(mediaSources(requestedAurral), ["aurral"]);
  for (const filePath of [lidarrOnly, sharedSingle, sharedLidarr, requestedAurral]) {
    assert.equal(await access(filePath).then(() => true, () => false), true);
  }

  const again = await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOff, lidarrRoots: [music] });
  assert.equal(again.lidarrRemoved, false);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });
  assert.equal(albumByTitle(`${tag} Only`).managed_by, "lidarr");
  assert.deepEqual(mediaSources(sharedLidarr), ["lidarr"]);
});

test("a Lidarr root folder inside the Downloads Folder belongs to Lidarr while it is on", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-nested-lidarr-"));
  const music = path.join(downloads, "music");
  const tag = `Nested ${process.pid}`;
  t.after(async () => {
    removeArtistsNamed(`${tag}%`);
    await rm(downloads, { recursive: true, force: true });
  });
  const nested = await createAudioFile(music, `${tag}/${tag} Album/01 Track.flac`);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });
  assert.deepEqual(mediaSources(nested), ["lidarr"]);
  assert.equal(albumByTitle(`${tag} Album`).managed_by, "lidarr");

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOff, lidarrRoots: [music] });
  assert.deepEqual(mediaSources(nested), ["aurral"]);
  assert.equal(albumByTitle(`${tag} Album`).managed_by, "aurral");
});

test("each folder is scanned by its deepest manager when Lidarr and Aurral folders nest", async (t) => {
  const music = await mkdtemp(path.join(tmpdir(), "aurral-deep-nesting-"));
  const downloads = path.join(music, "downloads");
  const innerLidarr = path.join(downloads, "lidarr");
  const tag = `Deep ${process.pid}`;
  t.after(async () => {
    removeArtistsNamed(`${tag}%`);
    await rm(music, { recursive: true, force: true });
  });
  const outer = await createAudioFile(music, `${tag} Outer/${tag} Outer Album/01 Track.flac`);
  const aurral = await createAudioFile(downloads, `${tag} Aurral/${tag} Aurral Album/01 Track.flac`);
  const inner = await createAudioFile(innerLidarr, `${tag} Inner/${tag} Inner Album/01 Track.flac`);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music, innerLidarr] });

  assert.deepEqual(mediaSources(outer), ["lidarr"]);
  assert.deepEqual(mediaSources(aurral), ["aurral"]);
  assert.deepEqual(mediaSources(inner), ["lidarr"]);
});

test("turning Lidarr off drops a Lidarr-only album link from a track Aurral keeps elsewhere", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-off-links-"));
  const tag = `Links ${process.pid}`;
  t.after(async () => {
    removeArtistsNamed(`${tag}%`);
    await rm(downloads, { recursive: true, force: true });
  });
  const aurralFile = await createAudioFile(downloads, `${tag}/${tag} Album/01 Shared.flac`);
  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [] });
  const album = albumByTitle(`${tag} Album`);
  const trackId = db.prepare("SELECT track_id FROM library_media_files WHERE path = ?").pluck().get(aurralFile);
  const compilation = upsertLibraryAlbum({
    identityKey: `${tag}:compilation`,
    artistId: album.artist_id,
    title: `${tag} Compilation`,
    syncSearch: false,
  });
  linkLibraryAlbumTrack({ albumId: compilation.id, trackId, trackNumber: 7, syncSearch: false });
  upsertLibraryMediaFile({
    trackId,
    albumId: compilation.id,
    source: "lidarr",
    path: path.join(tmpdir(), `${tag}-compilation.flac`),
    available: true,
  });

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOff });

  assert.equal(albumByTitle(`${tag} Compilation`), undefined);
  assert.deepEqual(albumTrackTitles(album.id), ["Shared"]);
  assert.deepEqual(mediaSources(aurralFile), ["aurral"]);
});

const metadata = {
  common: {
    albumartist: "Aurral Fixture",
    artist: "Aurral Fixture",
    album: "Playback Roadmap",
    title: "First Step",
    track: { no: 1, of: 4 },
    disk: { no: 1, of: 1 },
    musicbrainz_albumartistid: "11111111-1111-4111-8111-111111111111",
    musicbrainz_releasegroupid: "22222222-2222-4222-8222-222222222222",
    musicbrainz_recordingid: "33333333-3333-4333-8333-333333333333",
  },
  format: {
    duration: 123.4,
    codec: "FLAC",
    sampleRate: 44100,
    bitsPerSample: 16,
  },
};

const songAt = (filePath) => ({
  ...metadata,
  common: { ...metadata.common, title: path.basename(filePath, path.extname(filePath)), musicbrainz_recordingid: undefined },
});

async function createAudioFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  return filePath;
}

function deleteIndexedFile(source, filePath) {
  const links = db.prepare(
    `SELECT media.track_id AS trackId, album_track.album_id AS albumId, album.artist_id AS artistId
     FROM library_media_files AS media
     LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = media.track_id
     LEFT JOIN library_albums AS album ON album.id = album_track.album_id
     WHERE media.source = ? AND media.path = ?`,
  ).all(source, filePath);
  db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(source, filePath);

  for (const { trackId, albumId, artistId } of links) {
    const remainingFiles = db.prepare(
      "SELECT COUNT(*) AS count FROM library_media_files WHERE track_id = ?",
    ).get(trackId).count;
    if (remainingFiles === 0) {
      db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(trackId);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(trackId);
    }
    if (albumId != null) {
      db.prepare(
        "DELETE FROM library_albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)",
      ).run(albumId, albumId);
    }
    if (artistId != null) {
      db.prepare(
        "DELETE FROM library_artists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)",
      ).run(artistId, artistId);
    }
  }
}

test("scanMusicRoot indexes tagged media and ignores Flow output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-scan-"));
  const source = `test-aurral-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Fixture/Playback Roadmap/01 First Step.flac");
    await createAudioFile(root, "aurral-weekly-flow/flow/ignored.flac");
    await createAudioFile(root, "_playlists/ignored.flac");
    await createAudioFile(root, "_staging/ignored.flac");
    await createAudioFile(root, "_fallback/ignored.flac");
    await createAudioFile(root, "_flows/flow/ignored.flac");
    await createAudioFile(root, ".hidden/ignored.flac");

    const result = await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });
    const snapshot = getLibrarySnapshot();
    const files = snapshot.files.filter((file) => file.source === source);

    assert.equal(result.filesSeen, 1);
    assert.equal(result.filesIndexed, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, filePath);
    assert.equal(snapshot.artists.some((artist) => artist.name === "Aurral Fixture"), true);
    assert.equal(snapshot.albums.some((album) => album.title === "Playback Roadmap"), true);
    assert.equal(snapshot.tracks.some((track) => track.title === "First Step"), true);
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot derives stable fallback records when tags are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-fallback-"));
  const source = `test-fallback-${process.pid}`;
  const filePaths = [];
  try {
    const names = ["02 Fallback Track", "2-03 - Bomb", "01-99 Luftballons", "02-22 Acacia Avenue"];
    for (const name of names) {
      filePaths.push(await createAudioFile(root, `Fallback Artist/Fallback Album/${name}.mp3`));
    }
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({ common: {}, format: {} }),
    });
    const indexed = filePaths.map((filePath) => db.prepare(
      `SELECT artist.name AS artistName, album.title AS albumTitle,
        track.title AS trackTitle, album_track.disc_number AS disc, album_track.track_number AS track, media.available
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath));

    assert.deepEqual(indexed, [
      ["Fallback Track", 1, 2],
      ["Bomb", 2, 3],
      ["99 Luftballons", 1, 1],
      ["22 Acacia Avenue", 1, 2],
    ].map(([trackTitle, disc, track]) => ({
      artistName: "Fallback Artist",
      albumTitle: "Fallback Album",
      trackTitle,
      disc,
      track,
      available: 1,
    })));
  } finally {
    for (const filePath of filePaths) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("upsertLibraryArtist promotes a name fallback when its MBID becomes known", () => {
  const name = `Identity Promotion ${process.pid} ${Date.now()}`;
  const mbid = "11111111-1111-4111-8111-111111111112";
  const fallback = upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", name),
    name,
  });
  const album = upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", fallback.identity_key, "Album"),
    artistId: fallback.id,
    title: "Album",
  });

  try {
    const resolved = upsertLibraryArtist({
      identityKey: `mbid:${mbid}`,
      mbid,
      name,
    });
    const fallbackAgain = upsertLibraryArtist({
      identityKey: buildFallbackIdentityKey("artist", name),
      name,
    });
    const artists = db.prepare("SELECT id, mbid FROM library_artists WHERE name = ?").all(name);
    const linkedAlbum = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(album.id);

    assert.deepEqual(artists, [{ id: resolved.id, mbid }]);
    assert.equal(resolved.id, fallback.id);
    assert.equal(fallbackAgain.id, resolved.id);
    assert.equal(linkedAlbum.artist_id, resolved.id);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE name = ?").run(name);
  }
});

test("upsertLibraryArtist repairs an existing fallback and MBID duplicate", () => {
  const name = `Identity Repair ${process.pid} ${Date.now()}`;
  const mbid = "11111111-1111-4111-8111-111111111113";
  const fallbackKey = buildFallbackIdentityKey("artist", name);
  const fallback = upsertLibraryArtist({
    identityKey: fallbackKey,
    name,
  });
  const album = upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", fallback.identity_key, "Album"),
    artistId: fallback.id,
    title: "Album",
  });
  const timestamp = Date.now();
  const resolvedId = Number(db.prepare(
    `INSERT INTO library_artists
      (identity_key, mbid, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`mbid:${mbid}`, mbid, name, timestamp, timestamp).lastInsertRowid);
  const userId = Number(db.prepare(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
  ).run(`identity-repair-${process.pid}-${timestamp}`, "hash").lastInsertRowid);
  db.prepare(
    `INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
     VALUES (?, 'artist', ?, ?)`,
  ).run(userId, fallbackKey, timestamp);

  try {
    const resolved = upsertLibraryArtist({ identityKey: `mbid:${mbid}`, mbid, name });
    const artists = db.prepare("SELECT id, mbid FROM library_artists WHERE name = ?").all(name);
    const linkedAlbum = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(album.id);
    const star = db.prepare(
      "SELECT entity_key FROM subsonic_stars WHERE user_id = ? AND entity_kind = 'artist'",
    ).get(userId);

    assert.deepEqual(artists, [{ id: resolvedId, mbid }]);
    assert.equal(resolved.id, resolvedId);
    assert.equal(linkedAlbum.artist_id, resolvedId);
    assert.equal(star.entity_key, `mbid:${mbid}`);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    db.prepare("DELETE FROM library_artists WHERE name = ?").run(name);
  }
});

test("upsertLibraryArtist merges normalized name variants when the MBID row exists first", () => {
  const suffix = `${process.pid} ${Date.now()}`;
  const cases = [
    {
      canonicalName: `Volcano! ${suffix}`,
      fallbackName: `Volcano ${suffix}`,
      mbid: "11111111-1111-4111-8111-111111111114",
    },
    {
      canonicalName: `Marshmello;Lil Peep ${suffix}`,
      fallbackName: `Marshmello, Lil Peep ${suffix}`,
      mbid: "11111111-1111-4111-8111-111111111115",
    },
  ];

  try {
    for (const entry of cases) {
      const resolved = upsertLibraryArtist({
        identityKey: `mbid:${entry.mbid}`,
        mbid: entry.mbid,
        name: entry.canonicalName,
      });
      const fallback = upsertLibraryArtist({
        identityKey: buildFallbackIdentityKey("artist", entry.fallbackName),
        name: entry.fallbackName,
      });

      assert.equal(fallback.id, resolved.id);
    }

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM library_artists WHERE name LIKE ?").get(`%${suffix}`)
        .count,
      cases.length,
    );
  } finally {
    db.prepare("DELETE FROM library_artists WHERE name LIKE ?").run(`%${suffix}`);
  }
});

test("a configured scan resolves untagged artists only on one unambiguous MusicBrainz match", async () => {
  const suffix = `${process.pid}${Date.now()}`;
  const names = {
    renamed: `Bravery${suffix}, The`,
    merged: `Pumpkins${suffix}`,
    ambiguous: `Nirvana${suffix}`,
    offline: `Offline${suffix}`,
  };
  const mbids = {
    renamed: "44444444-4444-4444-8444-444444444441",
    merged: "44444444-4444-4444-8444-444444444442",
    ambiguousOne: "44444444-4444-4444-8444-444444444443",
    ambiguousTwo: "44444444-4444-4444-8444-444444444444",
    offline: "44444444-4444-4444-8444-444444444445",
  };
  let offlineAvailable = false;
  const server = await createMockHttpServer((request, response) => {
    const query = new URL(request.url, "http://mock").searchParams.get("query");
    const results = {
      [names.renamed]: [{ id: mbids.renamed, artistname: `The Bravery${suffix}` }],
      [names.merged]: [
        { id: mbids.merged, artistname: `The Pumpkins${suffix}`, artistaliases: [names.merged] },
        { id: "44444444-4444-4444-8444-444444444449", artistname: `Pumpkins${suffix} Tribute` },
      ],
      [names.ambiguous]: [
        { id: mbids.ambiguousOne, artistname: names.ambiguous },
        { id: mbids.ambiguousTwo, artistname: names.ambiguous },
      ],
      [names.offline]: [{ id: mbids.offline, artistname: names.offline }],
    }[query] || [];
    if (query === names.offline && !offlineAvailable) {
      response.writeHead(500);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(results));
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  const root = await mkdtemp(path.join(tmpdir(), "aurral-unmatched-artists-"));
  const existing = upsertLibraryArtist({
    identityKey: `mbid:${mbids.merged}`,
    mbid: mbids.merged,
    name: `The Pumpkins${suffix}`,
  });
  const artistFor = (name) => db.prepare(
    `SELECT artist.id, artist.mbid, artist.name
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.title = ?`,
  ).get(`${name} Album`);

  try {
    for (const name of [names.renamed, names.merged, names.ambiguous]) {
      await createAudioFile(root, `${name}/${name} Album/01 Track.mp3`);
    }
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(
      { mbid: artistFor(names.renamed).mbid, name: artistFor(names.renamed).name },
      { mbid: mbids.renamed, name: names.renamed },
    );
    assert.equal(artistFor(names.merged).id, existing.id);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM library_artists WHERE name = ?").get(names.merged).count,
      0,
    );
    assert.equal(artistFor(names.ambiguous).mbid, null);

    await createAudioFile(root, `${names.offline}/${names.offline} Album/01 Track.mp3`);
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
    assert.equal(artistFor(names.offline).mbid, null);

    offlineAvailable = true;
    clearMetadataProviderCaches();
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
    assert.equal(artistFor(names.offline).mbid, mbids.offline);
  } finally {
    for (const filePath of getLibrarySnapshot().files.map((file) => file.path)) {
      if (filePath.startsWith(root)) deleteIndexedFile("aurral", filePath);
    }
    db.prepare("DELETE FROM library_artists WHERE name LIKE ?").run(`%${suffix}%`);
    db.prepare("DELETE FROM musicbrainz_artist_mbid_cache WHERE artist_name_key LIKE ?")
      .run(`%${suffix}%`);
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot applies trusted job metadata when file tags omit identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-job-metadata-"));
  const source = `test-job-metadata-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({ common: {}, format: {} }),
      metadataEnricher: () => ({
        artistMbid: "11111111-1111-4111-8111-111111111111",
        albumMbid: "22222222-2222-4222-8222-222222222222",
        trackMbid: "33333333-3333-4333-8333-333333333333",
        artistName: "Aurral Artist",
        albumName: "Aurral Album",
        trackName: "Track",
      }),
    });
    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      releaseGroupMbid: "22222222-2222-4222-8222-222222222222",
      trackMbid: "33333333-3333-4333-8333-333333333333",
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

const fileRows = (source, filePath) => db.prepare(
  `SELECT media.album_id AS albumId, media.track_id AS trackId, album.identity_key AS albumKey, track.identity_key AS trackKey
   FROM library_media_files AS media
   JOIN library_albums AS album ON album.id = media.album_id
   JOIN library_tracks AS track ON track.id = media.track_id
   WHERE media.source = ? AND media.path = ?`,
).get(source, filePath);

const artistAlbums = (artistName) => db.prepare(
  `SELECT album.id, album.title, album.identity_key AS identityKey,
     (SELECT COUNT(*) FROM library_album_tracks AS link WHERE link.album_id = album.id) AS tracks
   FROM library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id
   WHERE artist.name = ? ORDER BY album.title`,
).all(artistName);

const untagged = (artist, album, title, track = 1) => ({
  common: { artist, albumartist: artist, album, title, track: { no: track, of: 2 }, disk: { no: 1, of: 1 } },
  format: { duration: 100 + track },
});

function starFor(userId, ...keys) {
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')").run(userId, `fan-${userId}`);
  for (const [kind, key] of keys) {
    db.prepare("INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, 1)").run(userId, kind, key);
  }
}

const starredKeys = (userId) => db.prepare(
  "SELECT entity_kind AS kind, entity_key AS key FROM subsonic_stars WHERE user_id = ? ORDER BY entity_kind, entity_key",
).all(userId).map(({ kind, key }) => [kind, key]);

test("a file that gains MusicBrainz IDs keeps its album and track, with their favorites and plays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-gains-ids-"));
  const source = `test-gains-ids-${process.pid}`;
  const artist = `Gains Ids ${process.pid}`;
  const userId = 9100 + (process.pid % 500);
  const releaseGroup = "f0ad7307-116d-4cf7-b2e6-8d865225373f";
  const recording = "056264d9-9c08-4201-a11c-849aa9306c0e";
  const filePath = await createAudioFile(root, `${artist}/22 Grand Job/01 - 22 Grand Job.flac`);
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: async () => untagged(artist, "22 Grand Job", "22 Grand Job") });
    const before = fileRows(source, filePath);
    starFor(userId, ["album", before.albumKey], ["song", before.trackKey]);
    db.prepare("INSERT INTO play_album_stats (user_id, album_key, play_count, last_played_at) VALUES (?, ?, 3, 1)")
      .run(userId, before.albumKey);

    const tagged = untagged(artist, "22 Grand Job", "22 Grand Job");
    Object.assign(tagged.common, { musicbrainz_releasegroupid: releaseGroup, musicbrainz_recordingid: recording });
    await scanMusicRoot({ rootPath: root, source, force: true, metadataReader: async () => tagged });

    const after = fileRows(source, filePath);
    assert.deepEqual(artistAlbums(artist).map((album) => album.identityKey), [`release-group:${releaseGroup}`]);
    assert.deepEqual([after.albumId, after.trackId], [before.albumId, before.trackId]);
    assert.equal(after.trackKey, `recording:${recording}`);
    assert.deepEqual(starredKeys(userId), [["album", after.albumKey], ["song", after.trackKey]]);
    assert.equal(db.prepare("SELECT play_count FROM play_album_stats WHERE user_id = ? AND album_key = ?").pluck()
      .get(userId, after.albumKey), 3);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a file retagged onto another album leaves no empty track or album behind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-retagged-"));
  const source = `test-retagged-${process.pid}`;
  const artist = `Retagged ${process.pid}`;
  const first = await createAudioFile(root, `${artist}/Old/01.flac`);
  const second = await createAudioFile(root, `${artist}/Old/02.flac`);
  const albumOf = { [first]: "Old", [second]: "Old" };
  const scan = () => scanMusicRoot({
    rootPath: root,
    source,
    force: true,
    metadataReader: async (filePath) => untagged(artist, albumOf[filePath], filePath === first ? "One" : "Two", filePath === first ? 1 : 2),
  });
  try {
    await scan();
    albumOf[second] = "New";
    await scan();
    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["New", 1], ["Old", 1]]);

    albumOf[first] = "New";
    await scan();
    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["New", 2]]);
    assert.equal(db.prepare(
      `SELECT COUNT(*) FROM library_tracks AS track WHERE track.title IN ('One', 'Two')
         AND track.identity_key LIKE ? AND NOT EXISTS (SELECT 1 FROM library_media_files AS media WHERE media.track_id = track.id)`,
    ).pluck().get(`%${artist.toLowerCase()}%`), 0);
  } finally {
    deleteIndexedFile(source, first);
    deleteIndexedFile(source, second);
    await rm(root, { recursive: true, force: true });
  }
});

test("a scan folds an album an earlier scan left without files into the album its files moved to, and removes ones with nowhere to go but keeps their favorites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-leftover-"));
  const source = `test-leftover-${process.pid}`;
  const artist = `Leftover ${process.pid}`;
  const userId = 9600 + (process.pid % 300);
  const filePath = await createAudioFile(root, `${artist}/7 Devils/08 - Jesus.flac`);
  const reader = async () => untagged(artist, "7 Devils", "Jesus", 8);
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    const left = fileRows(source, filePath);
    const artistId = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").pluck().get(left.albumId);
    const twinAlbum = upsertLibraryAlbum({ identityKey: "release-group:0ef07919-a3b3-47fd-a8ce-7e9a54543c9c", artistId, title: "7 Devils", syncSearch: false });
    const twinTrack = upsertLibraryTrack({ identityKey: "recording:466ad431-4159-4b53-ac9e-aac9599d9786", title: "Jesus", syncSearch: false });
    linkLibraryAlbumTrack({ albumId: twinAlbum.id, trackId: twinTrack.id, discNumber: 1, trackNumber: 8, syncSearch: false });
    db.prepare("UPDATE library_media_files SET album_id = ?, track_id = ? WHERE source = ? AND path = ?")
      .run(twinAlbum.id, twinTrack.id, source, filePath);
    const lonely = (title, key) => {
      const album = upsertLibraryAlbum({ identityKey: `name:album:${key}`, artistId, title, syncSearch: false });
      const track = upsertLibraryTrack({ identityKey: `name:track:${key}`, title, syncSearch: false });
      linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: 1, syncSearch: false });
      return track;
    };
    lonely("Gone Elsewhere", `${artist} gone`);
    const kept = lonely("Still Starred", `${artist} starred`);
    starFor(userId, ["album", left.albumKey], ["song", left.trackKey], ["song", kept.identity_key]);

    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["7 Devils", 1]]);
    assert.deepEqual(fileRows(source, filePath), {
      albumId: twinAlbum.id, trackId: twinTrack.id, albumKey: twinAlbum.identity_key, trackKey: twinTrack.identity_key,
    });
    assert.deepEqual(starredKeys(userId), [["album", twinAlbum.identity_key], ["song", kept.identity_key], ["song", twinTrack.identity_key]]);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

const tagged = (artist, album, title, track, releaseGroup, recording) => {
  const metadata = untagged(artist, album, title, track);
  Object.assign(metadata.common, { musicbrainz_releasegroupid: releaseGroup, musicbrainz_recordingid: recording });
  return metadata;
};

const filesOnTrack = (trackId) => db.prepare(
  "SELECT path FROM library_media_files WHERE track_id = ? ORDER BY path",
).pluck().all(trackId);

test("an album split between untagged and tagged files is one album that lists each song once, through rescans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-split-"));
  const source = `test-split-${process.pid}`;
  const artist = `Split ${process.pid}`;
  const userId = 9900 + (process.pid % 90);
  const releaseGroup = "6c4a1b2e-3d4f-4a5b-8c6d-7e8f9a0b1c2d";
  const tags = {};
  const reader = async (filePath) => tags[filePath];
  const copy = await createAudioFile(root, `${artist}/Mellon Collie/01 Tonight.flac`);
  const only = await createAudioFile(root, `${artist}/Mellon Collie/02 Zero.flac`);
  tags[copy] = untagged(artist, "Mellon Collie", "Tonight, Tonight", 1);
  tags[only] = untagged(artist, "Mellon Collie", "Zero", 2);
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    starFor(userId, ["album", fileRows(source, only).albumKey]);
    const original = await createAudioFile(root, `${artist}/Mellon Collie (Tagged)/01 Tonight.flac`);
    tags[original] = tagged(artist, "Mellon Collie", "Tonight, Tonight", 1, releaseGroup, "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");

    for (const force of [false, true]) {
      await scanMusicRoot({ rootPath: root, source, force, metadataReader: reader });
      assert.deepEqual(artistAlbums(artist).map(({ title, identityKey, tracks }) => [title, identityKey, tracks]), [
        ["Mellon Collie", `release-group:${releaseGroup}`, 2],
      ]);
      assert.deepEqual(filesOnTrack(fileRows(source, original).trackId), [copy, original].sort());
      assert.deepEqual(starredKeys(userId), [["album", `release-group:${releaseGroup}`]]);
    }
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("an untagged file joins the one of an artist's same-titled releases that lists its song", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-same-title-"));
  const source = `test-same-title-${process.pid}`;
  const artist = `Same Title ${process.pid}`;
  const tags = {};
  const blue = await createAudioFile(root, `${artist}/Blue/04 Buddy Holly.flac`);
  const green = await createAudioFile(root, `${artist}/Green/03 Hash Pipe.flac`);
  tags[blue] = tagged(artist, "Weezer", "Buddy Holly", 4, "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f");
  tags[green] = tagged(artist, "Weezer", "Hash Pipe", 3, "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a", "4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b");
  const reader = async (filePath) => tags[filePath];
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    const copy = await createAudioFile(root, `${artist}/Weezer/04 Buddy Holly.mp3`);
    tags[copy] = untagged(artist, "Weezer", "Buddy Holly", 4);
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Weezer", 1], ["Weezer", 1]]);
    assert.equal(fileRows(source, copy).trackId, fileRows(source, blue).trackId);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a scan removes albums nobody can play or asked for, and keeps the ones Aurral or Lidarr was asked for", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-owners-"));
  const artistName = `Owners ${process.pid}`;
  const leftoverName = `Catalogue Only ${process.pid}`;
  const artist = upsertLibraryArtist({ identityKey: `name:artist:owners ${process.pid}`, name: artistName, syncSearch: false });
  const leftoverArtist = upsertLibraryArtist({ identityKey: `name:artist:catalogue ${process.pid}`, name: leftoverName, syncSearch: false });
  const album = (owner, title, metadata, management = null) => {
    const row = upsertLibraryAlbum({ identityKey: `owners:${process.pid}:${title}`, artistId: owner.id, title, metadata, syncSearch: false });
    const track = upsertLibraryTrack({ identityKey: `owners:${process.pid}:${title}:track`, title: `${title} Song`, syncSearch: false });
    linkLibraryAlbumTrack({ albumId: row.id, trackId: track.id, trackNumber: 1, syncSearch: false });
    if (management) setLibraryManagement({ entityKind: "album", entityId: row.id, ...management });
    return track;
  };
  const lidarrRecord = { foreignAlbumId: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c", profileId: 1, anyReleaseOk: true, monitored: true };
  const catalogueTrack = album(artist, "Catalogue", lidarrRecord);
  album(leftoverArtist, "Catalogue Elsewhere", lidarrRecord);
  album(artist, "Scanned Away", { tags: { album: "Scanned Away" }, monitored: false }, { managedBy: "aurral" });
  album(artist, "Requested", { librarySource: "aurral", trackListComplete: true, monitored: true }, { managedBy: "aurral", monitorMode: "monitored" });
  album(artist, "Unmonitored", { librarySource: "aurral", trackListComplete: true, monitored: false }, { managedBy: "aurral", monitorMode: "unmonitored" });
  album(artist, "Lidarr Wants", { librarySource: "lidarr", monitored: true }, { managedBy: "lidarr" });
  const wanted = upsertLibraryAlbum({
    identityKey: `owners:${process.pid}:Wanted`, artistId: artist.id, title: "Wanted", metadata: { librarySource: "lidarr", monitored: true }, syncSearch: false,
  });
  setLibraryManagement({ entityKind: "album", entityId: wanted.id, managedBy: "lidarr" });
  const leftover = upsertLibraryAlbum({ identityKey: `name:album:owners ${process.pid}:wanted`, artistId: artist.id, title: "Wanted", syncSearch: false });
  const leftoverTrack = upsertLibraryTrack({ identityKey: `name:track:owners ${process.pid}:wanted`, title: "Wanted Song", syncSearch: false });
  linkLibraryAlbumTrack({ albumId: leftover.id, trackId: leftoverTrack.id, trackNumber: 1, syncSearch: false });
  try {
    await scanMusicRoot({ rootPath: root, source: `test-owners-${process.pid}` });

    assert.deepEqual(artistAlbums(artistName).map(({ title }) => title), ["Lidarr Wants", "Requested", "Unmonitored", "Wanted"]);
    assert.equal(db.prepare("SELECT managed_by FROM library_management WHERE entity_kind = 'album' AND entity_id = ?").pluck().get(wanted.id), "lidarr");
    assert.deepEqual(artistAlbums(leftoverName), []);
    assert.equal(db.prepare("SELECT COUNT(*) FROM library_artists WHERE name = ?").pluck().get(leftoverName), 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM library_tracks WHERE id = ?").pluck().get(catalogueTrack.id), 0);
  } finally {
    removeArtistsNamed(`Owners ${process.pid}`);
    removeArtistsNamed(`Catalogue Only ${process.pid}`);
    await rm(root, { recursive: true, force: true });
  }
});

test("songs a catalogue album shares with other albums keep their identity and stop matching its title when it folds or goes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-shared-recording-"));
  const source = `test-shared-recording-${process.pid}`;
  const artist = `Shared Recording ${process.pid}`;
  const blueTitle = `Blue ${process.pid}`;
  const vaultTitle = `Vault ${process.pid}`;
  const tags = {};
  const blue = await createAudioFile(root, `${artist}/Blue/04 Buddy Holly.flac`);
  const hit = await createAudioFile(root, `${artist}/Hits/01 Buddy Holly.flac`);
  const rarity = await createAudioFile(root, `${artist}/Hits/02 Susanne.flac`);
  const hitsGroup = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
  tags[blue] = tagged(artist, blueTitle, "Buddy Holly", 4,
    "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b", "1f2a3b4c-5d6e-4f7a-8b8c-9d0e1f2a3b4c");
  tags[hit] = tagged(artist, "Greatest Hits", "Buddy Holly", 1, hitsGroup, "3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d6e");
  tags[rarity] = tagged(artist, "Greatest Hits", "Susanne", 2, hitsGroup, "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b");
  const reader = async (filePath) => tags[filePath];
  const searchedTracks = (query) => getLibrarySearchPage({ query }).tracks.tracks.map((track) => Number(track.id));
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    const before = Object.fromEntries(Object.keys(tags).map((filePath) => [filePath, fileRows(source, filePath)]));
    const artistId = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").pluck().get(before[hit].albumId);
    for (const [title, releaseGroup, filePath, trackNumber] of [
      [vaultTitle, "5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f8a", rarity, 1],
      [blueTitle, "4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e7f", hit, 4],
    ]) {
      const catalogue = upsertLibraryAlbum({
        identityKey: `release-group:${releaseGroup}`,
        artistId,
        title,
        metadata: { foreignAlbumId: releaseGroup, monitored: true },
      });
      linkLibraryAlbumTrack({ albumId: catalogue.id, trackId: before[filePath].trackId, discNumber: 1, trackNumber });
    }
    assert.deepEqual(searchedTracks(vaultTitle), [before[rarity].trackId]);
    assert.deepEqual(searchedTracks(blueTitle).sort(), [before[blue].trackId, before[hit].trackId].sort());

    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [[blueTitle, 1], ["Greatest Hits", 2]]);
    for (const filePath of Object.keys(tags)) assert.deepEqual(fileRows(source, filePath), before[filePath]);
    assert.deepEqual(searchedTracks(vaultTitle), []);
    assert.deepEqual(searchedTracks(blueTitle), [before[blue].trackId]);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a song whose files are gone leaves an album that still plays unless someone asked for it, and comes back with its file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-missing-"));
  const source = `test-missing-${process.pid}`;
  const artist = `Missing ${process.pid}`;
  const tags = {};
  const file = async (album, title, track, extension = "flac") => {
    const filePath = await createAudioFile(root, `${artist}/${album}/${track} ${title}.${extension}`);
    tags[filePath] = untagged(artist, album, title, track);
    return filePath;
  };
  const headlight = await file("Horse", "One Headlight", 1);
  const lostCopy = await file("Horse", "One Headlight", 1, "m4a");
  const marlenas = await file("Horse", "Three Marlenas", 2);
  const wanted = await file("Horse", "The Difference", 3);
  await file("Requested", "Kept", 1);
  const requestedMissing = await file("Requested", "Coming", 2);
  const lonely = await file("Unplugged", "Lonely", 1);
  const scan = () => scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => tags[filePath] });
  try {
    await scan();
    const unwanted = [headlight, marlenas, requestedMissing, lonely].map((filePath) => fileRows(source, filePath).trackId);
    db.prepare(`UPDATE library_tracks SET monitored = 0 WHERE id IN (${unwanted.map(() => "?").join(",")})`).run(...unwanted);
    setLibraryManagement({ entityKind: "album", entityId: fileRows(source, requestedMissing).albumId, managedBy: "aurral", monitorMode: "monitored" });
    const lostTrack = fileRows(source, marlenas).trackId;
    for (const filePath of [lostCopy, marlenas, wanted, requestedMissing, lonely]) await rm(filePath);

    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Horse", 2], ["Requested", 2], ["Unplugged", 1]]);
    assert.deepEqual(filesOnTrack(fileRows(source, headlight).trackId), [headlight]);
    assert.deepEqual(filesOnTrack(lostTrack), []);
    assert.deepEqual([wanted, requestedMissing, lonely].map((filePath) => Boolean(fileRows(source, filePath))), [true, true, true]);

    await file("Horse", "Three Marlenas", 2);
    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Horse", 3], ["Requested", 2], ["Unplugged", 1]]);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a file row naming an album its track is not on shows on the track's album when that empty album goes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-stray-"));
  const source = `test-stray-${process.pid}`;
  const elsewhere = `test-stray-elsewhere-${process.pid}`;
  const artist = `Stray ${process.pid}`;
  const strayPath = path.join(root, "elsewhere", "Where Is My Mind.flac");
  const filePath = await createAudioFile(root, `${artist}/Death to the Pixies/01 Where Is My Mind.flac`);
  const reader = async () => tagged(artist, "Death to the Pixies", "Where Is My Mind?", 1,
    "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e");
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    const twin = fileRows(source, filePath);
    const artistId = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").pluck().get(twin.albumId);
    const leftover = upsertLibraryAlbum({ identityKey: `name:album:stray ${process.pid}`, artistId, title: "Pixies Rarities", syncSearch: false });
    const leftoverTrack = upsertLibraryTrack({ identityKey: `name:track:stray ${process.pid}`, title: "Where Is My Mind?", syncSearch: false });
    linkLibraryAlbumTrack({ albumId: leftover.id, trackId: leftoverTrack.id, trackNumber: 0, syncSearch: false });
    upsertLibraryMediaFile({ trackId: twin.trackId, albumId: leftover.id, source: elsewhere, path: strayPath });

    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Death to the Pixies", 1]]);
    assert.equal(fileRows(elsewhere, strayPath).albumId, twin.albumId);
    assert.deepEqual(filesOnTrack(twin.trackId), [filePath, strayPath].sort());
  } finally {
    deleteIndexedFile(elsewhere, strayPath);
    deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("an untagged copy an album lists beside its tagged track becomes that track", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-copy-row-"));
  const source = `test-copy-row-${process.pid}`;
  const elsewhere = `test-copy-row-elsewhere-${process.pid}`;
  const artist = `Copy Row ${process.pid}`;
  const copyPath = path.join(root, "elsewhere", "03 Song.mp3");
  const filePath = await createAudioFile(root, `${artist}/Album/03 Song.flac`);
  const reader = async () => tagged(artist, "Album", "Song", 3,
    "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a");
  try {
    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    const kept = fileRows(source, filePath);
    const copy = upsertLibraryTrack({ identityKey: `name:track:copy row ${process.pid}:1:3:song`, title: "Song", syncSearch: false });
    linkLibraryAlbumTrack({ albumId: kept.albumId, trackId: copy.id, discNumber: 1, trackNumber: 3, syncSearch: false });
    upsertLibraryMediaFile({ trackId: copy.id, albumId: kept.albumId, source: elsewhere, path: copyPath });

    await scanMusicRoot({ rootPath: root, source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Album", 1]]);
    assert.deepEqual(filesOnTrack(kept.trackId), [copyPath, filePath].sort());
  } finally {
    deleteIndexedFile(elsewhere, copyPath);
    deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot reads Aurral identity markers from portable comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-comment-metadata-"));
  const source = `test-comment-metadata-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({
        common: {
          comment: [{
            text: 'AURRAL_IDS={"artistMbid":"11111111-1111-4111-1111-111111111111","albumMbid":"22222222-2222-2222-2222-222222222222","trackMbid":"33333333-3333-3333-3333-333333333333"}',
          }],
        },
        format: {},
      }),
    });
    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-1111-111111111111",
      releaseGroupMbid: "22222222-2222-2222-2222-222222222222",
      trackMbid: "33333333-3333-3333-3333-333333333333",
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot reads Aurral identity markers from grouping tags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-grouping-metadata-"));
  const source = `test-grouping-metadata-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.m4a");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({
        common: {
          grouping:
            'AURRAL_IDS={"trackMbid":"33333333-3333-3333-3333-333333333333"}',
          comment:
            'AURRAL_IDS={"artistMbid":"11111111-1111-4111-1111-111111111111","albumMbid":"22222222-2222-2222-2222-222222222222"}',
        },
        format: {},
      }),
    });
    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-1111-111111111111",
      releaseGroupMbid: "22222222-2222-2222-2222-222222222222",
      trackMbid: "33333333-3333-3333-3333-333333333333",
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("scanMusicRoot reads Aurral identity markers from native ID3 comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-native-comment-metadata-"));
  const source = `test-native-comment-metadata-${process.pid}`;
  let filePath;

  try {
    filePath = await createAudioFile(root, "Aurral Artist/Aurral Album/01 Track.mp3");

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => ({
        common: {
          albumartist: "Aurral Artist",
          artist: "Aurral Artist",
          album: "Aurral Album",
          title: "Track",
          musicbrainz_trackid: "44444444-4444-4444-8444-444444444444",
        },
        native: {
          "ID3v2.4": [
            {
              id: "TXXX:comment",
              value:
                'AURRAL_IDS={"artistMbid":"11111111-1111-4111-8111-111111111111","albumMbid":"22222222-2222-4222-8222-222222222222","trackMbid":"33333333-3333-4333-8333-333333333333"}',
            },
          ],
        },
        format: {},
      }),
    });

    const indexed = db.prepare(
      `SELECT artist.mbid AS artistMbid, album.release_group_mbid AS releaseGroupMbid,
        track.mbid AS trackMbid
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
       JOIN library_albums AS album ON album.id = album_track.album_id
       JOIN library_artists AS artist ON artist.id = album.artist_id
       WHERE media.source = ? AND media.path = ?`,
    ).get(source, filePath);

    assert.deepEqual(indexed, {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      releaseGroupMbid: "22222222-2222-4222-8222-222222222222",
      trackMbid: "33333333-3333-4333-8333-333333333333",
    });
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful rescan marks removed files unavailable without removing media records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-reconcile-"));
  const source = `test-reconcile-${process.pid}`;
  try {
    const filePath = await createAudioFile(root, "Artist/Album/01 Track.mp3");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async (filePath) => songAt(filePath),
    });
    await rm(filePath);

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async (filePath) => songAt(filePath),
    });
    const snapshot = getLibrarySnapshot();
    const file = snapshot.files.find((entry) => entry.path === filePath);

    assert.equal(file?.available, 0);
    assert.equal(snapshot.tracks.some((track) => track.title === "01 Track"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial rescan preserves the last known-good file availability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-partial-"));
  const source = `test-partial-${process.pid}`;
  try {
    await createAudioFile(root, "Artist/Album/01 Track.flac");
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => metadata,
    });

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async () => {
        throw new Error("metadata unavailable");
      },
    });
    const file = getLibrarySnapshot().files.find((entry) => entry.source === source);

    assert.equal(file?.available, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unchanged local rescan skips metadata parsing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-unchanged-"));
  const source = `test-unchanged-${process.pid}`;
  let filePath;
  let metadataReads = 0;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    const metadataReader = async () => {
      metadataReads += 1;
      return metadata;
    };

    await scanMusicRoot({ rootPath: root, source, metadataReader });
    await scanMusicRoot({ rootPath: root, source, metadataReader });

    assert.equal(metadataReads, 1);
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a targeted local rescan only parses changed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-targeted-"));
  const source = `test-targeted-${process.pid}`;
  const filePaths = [];
  const metadataReads = [];
  const metadataReader = async (filePath) => {
    metadataReads.push(filePath);
    return metadata;
  };
  try {
    filePaths.push(await createAudioFile(root, "Artist/Album/01 First.flac"));
    filePaths.push(await createAudioFile(root, "Artist/Album/02 Second.flac"));

    await scanMusicRoot({ rootPath: root, source, metadataReader });
    metadataReads.length = 0;
    await writeFile(filePaths[0], "changed fixture");
    await scanMusicRoot({
      rootPath: root,
      source,
      changedPaths: [filePaths[0]],
      metadataReader,
    });

    assert.deepEqual(metadataReads, [filePaths[0]]);
  } finally {
    for (const filePath of filePaths) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a targeted rescan marks a deleted changed file unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-targeted-delete-"));
  const source = `test-targeted-delete-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    await scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => songAt(filePath) });
    await rm(filePath);
    await scanMusicRoot({
      rootPath: root,
      source,
      changedPaths: [filePath],
      metadataReader: async (filePath) => songAt(filePath),
    });

    assert.equal(
      getLibrarySnapshot().files.find((file) => file.path === filePath)?.available,
      0,
    );
  } finally {
    if (filePath) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("path scope matching handles large watcher batches without pairwise comparisons", () => {
  const root = path.join(tmpdir(), "aurral-large-path-scope");
  const scopes = Array.from(
    { length: 4096 },
    (_, index) => path.join(root, `Artist ${index}`, "Album", `${index}.flac`),
  );
  const matchesScope = createPathScopeMatcher(scopes);
  const startedAt = performance.now();

  for (let index = 0; index < scopes.length; index += 1) {
    assert.equal(matchesScope(scopes[index]), true);
    assert.equal(
      matchesScope(path.join(root, `Unrelated ${index}`, "Album", `${index}.flac`)),
      false,
    );
  }

  assert.ok(performance.now() - startedAt < 2_000);
});

test("a targeted directory rescan marks only removed descendants unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-targeted-directory-"));
  const source = `test-targeted-directory-${process.pid}`;
  const removedDirectory = path.join(root, "Artist", "Removed Album");
  const filePaths = [];
  try {
    filePaths.push(await createAudioFile(root, "Artist/Removed Album/01 First.flac"));
    filePaths.push(await createAudioFile(root, "Artist/Removed Album/02 Second.flac"));
    filePaths.push(await createAudioFile(root, "Artist/Kept Album/01 Kept.flac"));
    await scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => songAt(filePath) });

    await rm(removedDirectory, { recursive: true });
    await scanMusicRoot({
      rootPath: root,
      source,
      changedPaths: [removedDirectory],
      metadataReader: async (filePath) => songAt(filePath),
    });

    const files = getLibrarySnapshot().files;
    assert.equal(files.find((file) => file.path === filePaths[0])?.available, 0);
    assert.equal(files.find((file) => file.path === filePaths[1])?.available, 0);
    assert.equal(files.find((file) => file.path === filePaths[2])?.available, 1);
  } finally {
    for (const filePath of filePaths) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a targeted rescan ignores symbolic links", async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), "aurral-library-symlink-root-")),
    mkdtemp(path.join(tmpdir(), "aurral-library-symlink-outside-")),
  ]);
  const source = `test-symlink-${process.pid}`;
  let linkPath;
  try {
    const outsidePath = await createAudioFile(roots[1], "Artist/Album/01 Track.flac");
    linkPath = path.join(roots[0], "linked.flac");
    await symlink(outsidePath, linkPath);
    let metadataReads = 0;

    await scanMusicRoot({
      rootPath: roots[0],
      source,
      changedPaths: [linkPath],
      metadataReader: async () => {
        metadataReads += 1;
        return metadata;
      },
    });

    assert.equal(metadataReads, 0);
    assert.equal(getLibrarySnapshot().files.some((file) => file.path === linkPath), false);
  } finally {
    if (linkPath) deleteIndexedFile(source, linkPath);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("a forced rescan of an unchanged Lidarr root does not rewrite library rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-unchanged-"));
  const filePath = await createAudioFile(root, "Stable Artist/Stable Album/01 Stable Track.flac");
  const artistMbid = "10101010-1010-4010-8010-101010101010";
  const albumMbid = "20202020-2020-4020-8020-202020202020";
  const trackMbid = "30303030-3030-4030-8030-303030303030";
  const genreStatsKey = `libraryGenreStats:unchanged-${process.pid}`;
  const scanMetadata = {
    ...metadata,
    common: {
      ...metadata.common,
      albumartist: "Stable Artist",
      artist: "Stable Artist",
      album: "Stable Album",
      title: "Stable Track",
      musicbrainz_albumartistid: artistMbid,
      musicbrainz_releasegroupid: albumMbid,
      musicbrainz_recordingid: trackMbid,
    },
  };
  const scan = () => scanMusicRoots({
    rootPaths: [root],
    source: "lidarr",
    force: true,
    metadataReader: async () => scanMetadata,
    syncSearch: false,
  });

  try {
    await scan();
    db.prepare("UPDATE library_artists SET updated_at = 1 WHERE mbid = ?").run(artistMbid);
    db.prepare("UPDATE library_albums SET updated_at = 1 WHERE release_group_mbid = ?").run(albumMbid);
    db.prepare("UPDATE library_tracks SET updated_at = 1 WHERE mbid = ?").run(trackMbid);
    db.prepare("UPDATE library_media_files SET updated_at = 1 WHERE source = 'lidarr' AND path = ?")
      .run(filePath);

    const changesBefore = db.prepare("SELECT total_changes() AS count").get().count;
    const result = await scan();
    const changesAfter = db.prepare("SELECT total_changes() AS count").get().count;

    assert.equal(result.changed, false);
    assert.equal(changesAfter - changesBefore, 2);
    assert.deepEqual({
      artist: db.prepare("SELECT updated_at FROM library_artists WHERE mbid = ?").get(artistMbid)?.updated_at,
      album: db.prepare("SELECT updated_at FROM library_albums WHERE release_group_mbid = ?").get(albumMbid)?.updated_at,
      track: db.prepare("SELECT updated_at FROM library_tracks WHERE mbid = ?").get(trackMbid)?.updated_at,
      media: db.prepare("SELECT updated_at FROM library_media_files WHERE source = 'lidarr' AND path = ?")
        .get(filePath)?.updated_at,
    }, { artist: 1, album: 1, track: 1, media: 1 });

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(genreStatsKey, "preserved");
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(genreStatsKey)?.value, "preserved");
  } finally {
    db.prepare("DELETE FROM settings WHERE key = ?").run(genreStatsKey);
    deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Lidarr artist without albums reads through the projection and picks up monitoring changes", async () => {
  const providerArtistId = "1212@deezer";
  const identityKey = `lidarr-artist:${providerArtistId}`;

  try {
    upsertLibraryArtist({
      identityKey,
      name: "Albumless Artist",
      metadata: {
        id: 1212,
        artistName: "Albumless Artist",
        foreignArtistId: providerArtistId,
        monitored: false,
        monitor: "none",
        librarySource: "lidarr",
      },
    });
    let projection = getLibraryArtistProjection({ reference: providerArtistId })[0];
    assert.equal(projection?.name, "Albumless Artist");
    assert.equal(projection?.foreignArtistId, providerArtistId);
    assert.equal(projection?.providerId, "1212");
    assert.equal(projection?.id, projection?.canonicalId);
    assert.deepEqual(projection?.sources, ["lidarr"]);
    assert.equal(projection?.lidarrManaged, true);
    assert.equal(projection?.monitored, false);

    upsertLibraryArtist({
      identityKey,
      name: "Albumless Artist",
      metadata: {
        monitored: true,
        monitor: "all",
        monitorOption: "all",
        addOptions: { monitor: "all" },
      },
    });
    projection = getLibraryArtistProjection({ reference: providerArtistId })[0];
    assert.equal(projection?.monitored, true);
    assert.equal(projection?.monitorOption, "all");
    assert.equal(projection?.lidarrManaged, true);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(identityKey);
  }
});

test("an album whose Lidarr files are all gone stays in library reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-missing-album-"));
  const filePath = await createAudioFile(root, "Missing Album Artist/Fully Missing Album/01 Missing Track.flac");
  const scanMetadata = {
    ...metadata,
    common: {
      ...metadata.common,
      albumartist: "Missing Album Artist",
      artist: "Missing Album Artist",
      album: "Fully Missing Album",
      title: "Missing Track",
      date: "2026-08-20",
      musicbrainz_albumartistid: "13131313-1313-4131-8131-131313131313",
      musicbrainz_releasegroupid: "14141414-1414-4141-8141-141414141414",
      musicbrainz_recordingid: "15151515-1515-4151-8151-151515151515",
    },
  };
  const scan = () => scanMusicRoots({
    rootPaths: [root],
    source: "lidarr",
    metadataReader: async () => scanMetadata,
  });

  try {
    await scan();
    await rm(filePath);
    await scan();
    const page = getLibraryPage({
      kind: "albums",
      page: 1,
      pageSize: 10,
      query: "Fully Missing Album",
    });

    assert.equal(page.items[0]?.title, "Fully Missing Album");
    assert.equal(page.items[0]?.availableTrackCount, 0);
  } finally {
    deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Lidarr file joins only the album it is tagged with", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-album-scope-"));
  const filePath = await createAudioFile(root, "Artist/Eve 6/01 Showerhead.flac");
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const firstAlbumMbid = "22222222-2222-4222-8222-222222222222";
  const secondAlbumMbid = "33333333-3333-4333-8333-333333333333";
  const recordingMbid = "44444444-4444-4444-8444-444444444444";
  const aurralPath = path.join(root, "Aurral/Eve 6/01 Showerhead.flac");
  try {
    const artist = upsertLibraryArtist({
      identityKey: `mbid:${artistMbid}`,
      mbid: artistMbid,
      name: "Eve 6",
    });
    const album = upsertLibraryAlbum({
      identityKey: `release-group:${secondAlbumMbid}`,
      mbid: secondAlbumMbid,
      releaseGroupMbid: secondAlbumMbid,
      artistId: artist.id,
      title: "Inside Out",
    });
    const track = upsertLibraryTrack({
      identityKey: `recording:${recordingMbid}`,
      mbid: recordingMbid,
      title: "Showerhead",
      artistName: "Eve 6",
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: aurralPath,
    });

    await scanMusicRoots({
      rootPaths: [root],
      source: "lidarr",
      metadataReader: async () => ({
        ...metadata,
        common: {
          ...metadata.common,
          albumartist: "Eve 6",
          artist: "Eve 6",
          album: "Eve 6",
          title: "Showerhead",
          musicbrainz_albumartistid: artistMbid,
          musicbrainz_releasegroupid: firstAlbumMbid,
          musicbrainz_recordingid: recordingMbid,
        },
      }),
      syncSearch: false,
    });

    const albumRows = db.prepare(
      `SELECT album.title AS title, COUNT(DISTINCT media.id) AS files
       FROM library_albums AS album
       JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
       LEFT JOIN library_media_files AS media
         ON media.track_id = album_track.track_id
        AND media.album_id = album_track.album_id
        AND media.source = 'lidarr'
        AND media.available = 1
       WHERE album.identity_key IN (?, ?)
       GROUP BY album.id
       ORDER BY album.title`,
    ).all(`release-group:${firstAlbumMbid}`, `release-group:${secondAlbumMbid}`);
    assert.deepEqual(albumRows, [
      { title: "Eve 6", files: 1 },
      { title: "Inside Out", files: 0 },
    ]);
    const lidarrPage = getLibraryPage({
      source: "lidarr",
      kind: "albums",
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(lidarrPage.items.map((item) => item.title), ["Eve 6"]);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE source = 'lidarr' AND path = ?").run(filePath);
    db.prepare("DELETE FROM library_media_files WHERE source = 'aurral' AND path = ?").run(aurralPath);
    const albumRows = db.prepare(
      "SELECT id FROM library_albums WHERE identity_key IN (?, ?)",
    ).all(`release-group:${firstAlbumMbid}`, `release-group:${secondAlbumMbid}`);
    const albumIds = albumRows.map((row) => row.id);
    if (albumIds.length) {
      db.prepare(
        `DELETE FROM library_album_tracks WHERE album_id IN (${albumIds.map(() => "?").join(",")})`,
      ).run(...albumIds);
      db.prepare(
        `DELETE FROM library_albums WHERE id IN (${albumIds.map(() => "?").join(",")})`,
      ).run(...albumIds);
    }
    db.prepare("DELETE FROM library_tracks WHERE identity_key = ?").run(`recording:${recordingMbid}`);
    db.prepare("DELETE FROM library_artists WHERE identity_key = ?").run(`mbid:${artistMbid}`);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Lidarr outage leaves the last indexed library available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-lidarr-outage-"));
  let filePath;
  try {
    filePath = await createAudioFile(root, "Outage Artist/Outage Album/01 Outage Track.flac");
    await scanConfiguredLibrary({
      musicRoot: path.join(root, "empty-aurral-root"),
      lidarrClient: lidarrOn,
      lidarrRoots: [root],
    });

    const result = await scanConfiguredLibrary({
      musicRoot: path.join(root, "empty-aurral-root"),
      lidarrClient: {
        isConfigured: () => true,
        isEnabled: () => true,
        request: async () => {
          throw new Error("Lidarr unavailable");
        },
      },
      lidarrRoots: [root],
    });
    const file = getLibrarySnapshot().files.find((entry) => entry.path === filePath);

    assert.equal(result.lidarr.error, undefined);
    assert.equal(result.lidarr.filesIndexed, 1);
    assert.equal(file?.available, 1);
  } finally {
    if (filePath) deleteIndexedFile("lidarr", filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("album/track relation changes move the library timestamp", async () => {
  const identityKey = `name:relation-timestamp-${process.pid}`;
  const artist = upsertLibraryArtist({ identityKey, name: "Relation Timestamp", syncSearch: false });
  const album = upsertLibraryAlbum({
    identityKey: `${identityKey}:album`,
    artistId: artist.id,
    title: "Relation Timestamp Album",
    syncSearch: false,
  });
  const tracks = ["kept", "dropped"].map((suffix) => upsertLibraryTrack({
    identityKey: `${identityKey}:${suffix}`,
    title: `Relation Timestamp ${suffix}`,
    artistName: "Relation Timestamp",
    syncSearch: false,
  }));
  const albumUpdatedAt = () =>
    db.prepare("SELECT updated_at FROM library_albums WHERE id = ?").get(album.id)?.updated_at;
  // Park the timestamp in the past so a bump is unambiguous at millisecond resolution.
  const parkTimestamp = () =>
    db.prepare("UPDATE library_albums SET updated_at = 1 WHERE id = ?").run(album.id);
  const relationCount = () =>
    db.prepare("SELECT COUNT(*) AS total FROM library_album_tracks WHERE album_id = ?")
      .get(album.id).total;

  try {
    linkLibraryAlbumTrack({ albumId: album.id, trackId: tracks[0].id, syncSearch: false });
    upsertLibraryMediaFile({
      trackId: tracks[0].id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/relation-timestamp-${process.pid}.flac`,
      available: true,
    });

    parkTimestamp();
    linkLibraryAlbumTrack({ albumId: album.id, trackId: tracks[1].id, syncSearch: false });
    assert.equal(relationCount(), 2);
    assert.ok(albumUpdatedAt() > 1, "linking a track must refresh the album timestamp");
    assert.ok(getLibraryIndexLastModified() >= albumUpdatedAt());

    upsertLibraryMediaFile({
      trackId: tracks[1].id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/relation-timestamp-dropped-${process.pid}.flac`,
      available: false,
    });
    parkTimestamp();
    assert.equal(removeLibraryTrackIfNoAvailableMedia(tracks[1].id), true);
    assert.equal(relationCount(), 1);
    assert.ok(albumUpdatedAt() > 1, "dropping a track must refresh the album timestamp");
    assert.ok(getLibraryIndexLastModified() >= albumUpdatedAt());
  } finally {
    for (const track of tracks) {
      db.prepare("DELETE FROM library_media_files WHERE track_id = ?").run(track.id);
      db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(track.id);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
    }
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    invalidateLibraryQueryCache();
  }
});
