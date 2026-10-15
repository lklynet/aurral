import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  assignLidarrAlbumOwners,
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

const execFileAsync = promisify(execFile);

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
    assert.equal(snapshot.files.some((file) => file.path === paths[0]), false);
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

test("a scan of several roots drops songs whose files are gone from albums nobody asked for, including ones an older scan only marked missing", async (t) => {
  const roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), "aurral-roots-gone-one-")),
    mkdtemp(path.join(tmpdir(), "aurral-roots-gone-two-")),
  ]);
  const source = `test-roots-gone-${process.pid}`;
  const artist = `Roots Gone ${process.pid}`;
  const tags = {};
  t.after(async () => {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    removeArtistsNamed(artist);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });
  for (const [root, album, title, track] of [[roots[0], "One", "Stays", 1], [roots[0], "One", "Gone", 2], [roots[1], "Two", "Other", 1], [roots[1], "Two", "Marked", 2]]) {
    tags[await createAudioFile(root, `${artist}/${album}/${track} ${title}.flac`)] = untagged(artist, album, title, track);
  }
  const scan = () => scanMusicRoots({ rootPaths: roots, source, metadataReader: async (filePath) => tags[filePath] });
  const [, gone, , marked] = Object.keys(tags);
  await scan();
  db.prepare("UPDATE library_media_files SET available = 0 WHERE source = ? AND path = ?").run(source, marked);
  await rm(gone);
  await rm(marked);

  await scan();

  assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["One", 1], ["Two", 1]]);
});

test("files in a folder Lidarr no longer has leave the Library", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-dropped-root-downloads-"));
  const kept = await mkdtemp(path.join(tmpdir(), "aurral-dropped-root-kept-"));
  const dropped = await mkdtemp(path.join(tmpdir(), "aurral-dropped-root-gone-"));
  const tag = `Dropped Root ${process.pid}`;
  t.after(async () => {
    removeArtistsNamed(`${tag}%`);
    await Promise.all([downloads, kept, dropped].map((root) => rm(root, { recursive: true, force: true })));
  });
  const stays = await createAudioFile(kept, `${tag}/${tag} Kept/01 Track.flac`);
  const leaves = await createAudioFile(dropped, `${tag}/${tag} Dropped/01 Track.flac`);
  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [kept, dropped] });
  assert.deepEqual([mediaSources(stays), mediaSources(leaves)], [["lidarr"], ["lidarr"]]);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [kept] });

  assert.deepEqual([mediaSources(stays), mediaSources(leaves)], [["lidarr"], []]);
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
  const album = albumByTitle(`${tag} Album`);
  const tracks = albumTrackTitles(album.id);

  await scanConfiguredLibrary({ musicRoot: downloads, lidarrClient: lidarrOn, lidarrRoots: [music] });
  assert.deepEqual([albumByTitle(`${tag} Album`).id, albumTrackTitles(album.id)], [album.id, tracks]);
  assert.equal(albumByTitle(`${tag} Album`).managed_by, "lidarr");
  assert.ok(mediaSources(nested).includes("lidarr"));
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

const uuid = (group, index) => `${group}-0000-4000-8000-${String(index).padStart(12, "0")}`;

async function withReleaseGroups(releaseGroups, run) {
  const state = { up: true, requests: [] };
  const server = await createMockHttpServer((request, response) => {
    const id = new URL(request.url, "http://mock").pathname.split("/").at(-1);
    state.requests.push(id);
    const group = releaseGroups[id];
    response.setHeader("content-type", "application/json");
    if (!state.up) {
      response.writeHead(500);
      response.end("{}");
      return;
    }
    if (!group) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.end(JSON.stringify({
      id,
      title: group.title,
      artistid: group.artistMbid,
      artists: [{ id: group.artistMbid, artistname: group.artist }, ...(group.credits || [])],
      releases: group.releases.map(({ id: releaseId, titles, perDisc = titles.length, recordings = group.recordings, merged = {} }) => ({
        id: releaseId,
        status: "Official",
        tracks: titles.map((title, index) => ({
          id: `${releaseId}-${index}`,
          recordingid: recordings[title],
          oldrecordingids: merged[title] || [],
          trackname: title,
          trackposition: (index % perDisc) + 1,
          mediumnumber: Math.floor(index / perDisc) + 1,
        })),
      })),
    }));
  });
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations.metadata, baseUrl: server.url, enableNarrowFallbacks: false },
    },
  });
  clearMetadataProviderCaches();
  try {
    await run(state);
  } finally {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
    await server.close();
  }
}

const albumListing = (title) => db.prepare(
  `SELECT track.title,
     EXISTS (SELECT 1 FROM library_media_files AS media WHERE media.track_id = track.id
       AND media.available = 1 AND (media.album_id = link.album_id OR media.album_id IS NULL)) AS have
   FROM library_albums AS album
   JOIN library_album_tracks AS link ON link.album_id = album.id
   JOIN library_tracks AS track ON track.id = link.track_id
   WHERE album.title = ? ORDER BY link.disc_number, link.track_number`,
).all(title).map(({ title: name, have }) => [name, have ? "have" : "missing"]);

let tone = 200;

async function makeTrack(filePath, tags) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `sine=frequency=${tone += 7}:duration=0.2`];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  await execFileAsync("ffmpeg", [...args, filePath]);
  return filePath;
}

function listedAlbum(artist, artistMbid, title, index, titles, releases = [{ id: uuid("bbbbbbbb", index), titles }]) {
  const recordings = Object.fromEntries(titles.map((name, position) => [name, uuid("cccccccc", index * 100 + position)]));
  const releaseGroup = uuid("aaaaaaaa", index);
  return {
    releaseGroup,
    group: { title, artist, artistMbid, recordings, releases },
    file: (folder, name, release = releaseGroup) => makeTrack(
      path.join(folder, artist, title, `${String(titles.indexOf(name) + 1).padStart(2, "0")} ${name}.flac`),
      {
        ARTIST: artist,
        ALBUMARTIST: artist,
        ALBUM: title,
        TITLE: name,
        TRACKNUMBER: titles.indexOf(name) + 1,
        MUSICBRAINZ_ALBUMARTISTID: artistMbid,
        MUSICBRAINZ_RELEASEGROUPID: releaseGroup,
        MUSICBRAINZ_ALBUMID: release,
        MUSICBRAINZ_TRACKID: recordings[name],
      },
    ),
  };
}

test("an album lists every track of the release its files are tagged with, including the ones it is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-"));
  const artist = `Track List ${process.pid}`;
  const artistMbid = uuid("dddddddd", 1);
  const deluxe = uuid("eeeeeeee", 1);
  const album = listedAlbum(artist, artistMbid, "Deluxe", 1, ["One", "Two", "Three", "Bonus"], [
    { id: uuid("eeeeeeee", 2), titles: ["One", "Two", "Three"] },
    { id: uuid("eeeeeeee", 3), titles: ["One", "Two", "Three"] },
    { id: deluxe, titles: ["One", "Two", "Three", "Bonus"] },
  ]);
  const scan = () => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
  try {
    await album.file(root, "One", deluxe);
    const two = await makeTrack(path.join(root, artist, "Deluxe", "02 Two.flac"), { ARTIST: artist, ALBUMARTIST: artist, ALBUM: "Deluxe", TITLE: "Two", TRACKNUMBER: 2 });
    const hidden = await makeTrack(path.join(root, artist, "Deluxe", "05 Hidden.flac"), { ARTIST: artist, ALBUMARTIST: artist, ALBUM: "Deluxe", TITLE: "Hidden", TRACKNUMBER: 5 });
    await makeTrack(path.join(root, artist, "Bonus Single", "01 Bonus.flac"), {
      ARTIST: artist, ALBUMARTIST: artist, ALBUM: "Bonus Single", TITLE: "Bonus (Radio Edit)", TRACKNUMBER: 1,
      MUSICBRAINZ_TRACKID: album.group.recordings.Bonus,
    });
    await withReleaseGroups({ [album.releaseGroup]: album.group }, async (provider) => {
      provider.up = false;
      await scan();
      assert.deepEqual(albumListing("Deluxe"), [["One", "have"], ["Two", "have"], ["Hidden", "have"]]);

      provider.up = true;
      await scan();
      const listed = [["One", "have"], ["Two", "have"], ["Three", "missing"], ["Bonus (Radio Edit)", "missing"], ["Hidden", "have"]];
      assert.deepEqual(albumListing("Deluxe"), listed);
      assert.deepEqual(albumListing("Bonus Single"), [["Bonus (Radio Edit)", "have"]]);
      const page = getLibraryPage({ kind: "albums", page: 1, pageSize: 10, query: "Deluxe" });
      assert.deepEqual([page.items[0]?.availableTrackCount, page.items[0]?.trackCount], [3, 5]);

      const modified = getLibraryIndexLastModified();
      await scan();
      assert.deepEqual(albumListing("Deluxe"), listed);
      assert.equal(getLibraryIndexLastModified(), modified);

      await rm(two);
      await rm(hidden);
      await scan();
      assert.deepEqual(albumListing("Deluxe"), [["One", "have"], ["Two", "missing"], ["Three", "missing"], ["Bonus (Radio Edit)", "missing"]]);

      await album.file(root, "One", uuid("eeeeeeee", 2));
      await scan();
      assert.deepEqual(albumListing("Deluxe"), [["One", "have"], ["Two", "missing"], ["Three", "missing"]]);
    });
  } finally {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  }
});

test("a release that lists a song twice lists it at both places, and a file numbered apart from the release is listed once", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-twice-"));
  const artist = `Twice List ${process.pid}`;
  const twice = listedAlbum(artist, uuid("dddddddd", 5), `Twice ${process.pid}`, 50, ["Intro", "Song", "Intro"]);
  const numbered = listedAlbum(artist, uuid("dddddddd", 5), `Numbered ${process.pid}`, 51, ["First", "Second"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await makeTrack(path.join(root, artist, `Twice ${process.pid}`, "03 Intro.flac"), {
    ARTIST: artist, ALBUMARTIST: artist, ALBUM: `Twice ${process.pid}`, TITLE: "Intro", TRACKNUMBER: 3,
    MUSICBRAINZ_ALBUMARTISTID: uuid("dddddddd", 5), MUSICBRAINZ_RELEASEGROUPID: twice.releaseGroup,
    MUSICBRAINZ_ALBUMID: uuid("bbbbbbbb", 50), MUSICBRAINZ_TRACKID: twice.group.recordings.Intro,
  });
  await makeTrack(path.join(root, artist, `Numbered ${process.pid}`, "04 First.flac"), {
    ARTIST: artist, ALBUMARTIST: artist, ALBUM: `Numbered ${process.pid}`, TITLE: "First", TRACKNUMBER: 4,
    MUSICBRAINZ_ALBUMARTISTID: uuid("dddddddd", 5), MUSICBRAINZ_RELEASEGROUPID: numbered.releaseGroup,
    MUSICBRAINZ_ALBUMID: uuid("bbbbbbbb", 51), MUSICBRAINZ_TRACKID: numbered.group.recordings.First,
  });
  await withReleaseGroups({ [twice.releaseGroup]: twice.group, [numbered.releaseGroup]: numbered.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(`Twice ${process.pid}`), [["Intro", "have"], ["Song", "missing"], ["Intro", "have"]]);
    assert.deepEqual(albumListing(`Numbered ${process.pid}`), [["Second", "missing"], ["First", "have"]]);
  });
});

test("a song an album keeps after its untagged file is gone is listed once, and stays when Lidarr is turned off", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-track-list-kept-downloads-"));
  const music = await mkdtemp(path.join(tmpdir(), "aurral-track-list-kept-music-"));
  const artist = `Kept List ${process.pid}`;
  const title = `Kept ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 4), title, 40, ["One", "Two", "Three"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await Promise.all([downloads, music].map((root) => rm(root, { recursive: true, force: true })));
  });
  await album.file(downloads, "One", uuid("bbbbbbbb", 40));
  const two = await makeTrack(path.join(music, artist, title, "02 Two.flac"), { ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: "Two", TRACKNUMBER: 2 });
  const scan = (lidarrClient = lidarrOn) => scanConfiguredLibrary({ musicRoot: downloads, lidarrClient, lidarrRoots: [music] });
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async (provider) => {
    provider.up = false;
    await scan();
    await rm(two);
    await scan();
    assert.deepEqual(albumListing(title), [["One", "have"], ["Two", "missing"]]);

    provider.up = true;
    await scan();
    const listed = [["One", "have"], ["Two", "missing"], ["Three", "missing"]];
    assert.deepEqual(albumListing(title), listed);

    await scan(lidarrOff);
    assert.deepEqual(albumListing(title), listed);
  });
});

test("an album lists the edition its files come from, again when a file of another edition joins it or a file is retagged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-edition-"));
  const artist = `Edition List ${process.pid}`;
  const title = `Edition ${process.pid}`;
  const standard = ["One", "Two", "Three"];
  const deluxe = [...standard, "Bonus", "Extra"];
  const album = listedAlbum(artist, uuid("dddddddd", 6), title, 60, [...deluxe, "Live"], [
    { id: uuid("bbbbbbbb", 63), titles: ["One"] },
    { id: uuid("bbbbbbbb", 60), titles: standard },
    { id: uuid("bbbbbbbb", 64), titles: [...deluxe, "Live"] },
    { id: uuid("bbbbbbbb", 61), titles: standard },
    { id: uuid("bbbbbbbb", 62), titles: deluxe },
  ]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  const scan = () => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await album.file(root, "One");
    await scan();
    assert.deepEqual(albumListing(title), [["One", "have"], ["Two", "missing"], ["Three", "missing"]]);

    await album.file(root, "Bonus");
    await scan();
    const listed = [["One", "have"], ["Two", "missing"], ["Three", "missing"], ["Bonus", "have"], ["Extra", "missing"]];
    assert.deepEqual(albumListing(title), listed);

    const modified = getLibraryIndexLastModified();
    await scan();
    assert.deepEqual(albumListing(title), listed);
    assert.equal(getLibraryIndexLastModified(), modified);

    await makeTrack(path.join(root, artist, title, "04 Bonus.flac"), {
      ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: "Two", TRACKNUMBER: 2,
      MUSICBRAINZ_ALBUMARTISTID: album.group.artistMbid, MUSICBRAINZ_RELEASEGROUPID: album.releaseGroup,
      MUSICBRAINZ_ALBUMID: album.releaseGroup, MUSICBRAINZ_TRACKID: album.group.recordings.Two,
    });
    await scan();
    assert.deepEqual(albumListing(title), [["One", "have"], ["Two", "have"], ["Three", "missing"]]);
  });
});

test("an album lists the release whose recordings its files are tagged with when another has the same titles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-recording-"));
  const artist = `Recording List ${process.pid}`;
  const title = `Recording ${process.pid}`;
  const remastered = { One: uuid("c0c0c0c0", 1), Two: uuid("c0c0c0c0", 2), Bonus: uuid("c0c0c0c0", 3) };
  const album = listedAlbum(artist, uuid("dddddddd", 9), title, 90, ["One", "Two"], [
    { id: uuid("bbbbbbbb", 90), titles: ["One", "Two"] },
    { id: uuid("bbbbbbbb", 91), titles: ["One", "Two"] },
    { id: uuid("bbbbbbbb", 92), titles: ["One", "Two", "Bonus"], recordings: remastered },
  ]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, name] of ["One", "Two"].entries()) {
    await makeTrack(path.join(root, artist, title, `0${index + 1} ${name}.flac`), {
      ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: name, TRACKNUMBER: index + 1,
      MUSICBRAINZ_ALBUMARTISTID: uuid("dddddddd", 9), MUSICBRAINZ_RELEASEGROUPID: album.releaseGroup,
      MUSICBRAINZ_ALBUMID: album.releaseGroup, MUSICBRAINZ_TRACKID: remastered[name],
    });
  }
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title), [["One", "have"], ["Two", "have"], ["Bonus", "missing"]]);
  });
});

test("remastered files numbered as one disc list each song of their edition once", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-remaster-"));
  const artist = `Remaster List ${process.pid}`;
  const title = `Remaster ${process.pid}`;
  const songs = ["Dawn", "Tonight", "Dusk", "Starlight", "Dawn (Demo)", "Dusk (Demo)"];
  const album = listedAlbum(artist, uuid("dddddddd", 7), title, 70, songs, [
    { id: uuid("bbbbbbbb", 70), titles: songs.slice(0, 4), perDisc: 2 },
    { id: uuid("bbbbbbbb", 71), titles: songs.slice(0, 4), perDisc: 2 },
    { id: uuid("bbbbbbbb", 72), titles: songs, perDisc: 2 },
  ]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  const untagged = (name, number) => makeTrack(path.join(root, artist, title, `${String(number).padStart(2, "0")} ${name}.flac`),
    { ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: name, TRACKNUMBER: number });
  await makeTrack(path.join(root, artist, title, "01 Dawn.flac"), {
    ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: "Dawn - Remastered 2012", TRACKNUMBER: 1,
    MUSICBRAINZ_ALBUMARTISTID: uuid("dddddddd", 7), MUSICBRAINZ_RELEASEGROUPID: album.releaseGroup,
    MUSICBRAINZ_ALBUMID: album.releaseGroup, MUSICBRAINZ_TRACKID: album.group.recordings.Dawn,
  });
  await untagged("Tonight (Remastered 2012)", 2);
  await untagged("Dusk - 2012 Remaster", 3);
  await untagged("Starlight [Remastered]", 4);
  await untagged("Dawn (Demo)", 5);
  await untagged("Dusk (Demo)", 6);
  await untagged("Tonight (Live)", 7);
  await untagged("Dusk (Live, Remastered 2012)", 8);
  const filesOn = () => db.prepare(
    "SELECT media.path, media.track_id FROM library_media_files AS media WHERE media.path LIKE ? ORDER BY media.path",
  ).all(`${root}%`);
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    const listed = [
      ["Dawn - Remastered 2012", "have"],
      ["Tonight", "have"],
      ["Tonight (Live)", "have"],
      ["Dusk (Live, Remastered 2012)", "have"],
      ["Dusk", "have"],
      ["Starlight", "have"],
      ["Dawn (Demo)", "have"],
      ["Dusk (Demo)", "have"],
    ];
    assert.deepEqual(albumListing(title), listed);

    const files = filesOn();
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false, force: true });
    assert.deepEqual(albumListing(title), listed);
    assert.deepEqual(filesOn(), files);
  });
});

test("an untagged file at a listed song's place is that song when its title is spelled another way or names a guest or its mix, not when it is another version", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-place-"));
  const artist = `Place List ${process.pid}`;
  const title = `Place ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 8), title, 80,
    ["Tongue Tied", "Fly", "Hooray", "The Rat House", "Today", "Stand by Me Tonight", "Get Down With Me", "Anchor", "Glide (Sped Up)", "Drift (Extended)", "Halo", "Spark", "Echo", "Ember", "Fable"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  const untagged = (name, number) => makeTrack(path.join(root, artist, title, `${String(number).padStart(2, "0")} ${name}.flac`),
    { ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: name, TRACKNUMBER: number });
  await album.file(root, "Anchor", uuid("bbbbbbbb", 80));
  await untagged("Tounge Tied", 1);
  await untagged("Fly (feat. Super Cat)", 2);
  await untagged("Hooray (Live)", 3);
  await untagged("Rat House", 4);
  await untagged("Today (Smashing Pumpkins Cover)", 5);
  await untagged("Stand", 6);
  await untagged("Groove With Me", 7);
  await untagged("Glide", 9);
  await untagged("Drift", 10);
  await untagged("Halo (feat. Live)", 11);
  await untagged("Spark feat. Live", 12);
  await untagged("Echo (Mono)", 13);
  await untagged("Ember - Mono Version", 14);
  await untagged("Fable (Stereo Mix)", 15);
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title).sort(), [
      ["Anchor", "have"],
      ["Drift (Extended)", "missing"],
      ["Drift", "have"],
      ["Echo", "have"],
      ["Ember", "have"],
      ["Fable", "have"],
      ["Fly", "have"],
      ["Get Down With Me", "missing"],
      ["Glide (Sped Up)", "missing"],
      ["Glide", "have"],
      ["Groove With Me", "have"],
      ["Halo", "have"],
      ["Hooray (Live)", "have"],
      ["Hooray", "missing"],
      ["Spark", "have"],
      ["Stand by Me Tonight", "missing"],
      ["Stand", "have"],
      ["The Rat House", "have"],
      ["Today", "have"],
      ["Tongue Tied", "have"],
    ]);
  });
});

test("an untagged song numbered apart from the album's song with its title stays its own when that song has a file or another copy shares the title", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-apart-"));
  const artist = `Apart List ${process.pid}`;
  const title = `Apart ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 10), title, 100,
    ["Intro", "Interlude", "Outro", "Skit", "Theme", "Theme (Remastered)"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  const untagged = (name, number) => makeTrack(path.join(root, artist, title, `${String(number).padStart(2, "0")} ${name}.flac`),
    { ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: name, TRACKNUMBER: number });
  await album.file(root, "Interlude", uuid("bbbbbbbb", 100));
  await untagged("Outro", 3);
  await untagged("Interlude", 7);
  await untagged("Skit", 8);
  await untagged("Skit", 9);
  await untagged("Outro", 10);
  await untagged("Theme", 11);
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title), [
      ["Intro", "missing"],
      ["Interlude", "have"],
      ["Outro", "have"],
      ["Skit", "missing"],
      ["Theme", "missing"],
      ["Theme (Remastered)", "missing"],
      ["Interlude", "have"],
      ["Skit", "have"],
      ["Skit", "have"],
      ["Outro", "have"],
      ["Theme", "have"],
    ]);
  });
});

const taggedTrack = (root, artist, title, album, name, number, recording, artistMbid = album.group.artistMbid) =>
  makeTrack(path.join(root, artist, title, `${String(number).padStart(2, "0")} ${name}.flac`), {
    ARTIST: artist, ALBUMARTIST: artist, ALBUM: title, TITLE: name, TRACKNUMBER: number,
    MUSICBRAINZ_ALBUMARTISTID: artistMbid, MUSICBRAINZ_RELEASEGROUPID: album.releaseGroup,
    MUSICBRAINZ_ALBUMID: album.releaseGroup, MUSICBRAINZ_TRACKID: recording,
  });

test("a file at a listed song's place is that song, keeping its own title when the album first lists, and taking the place of a song an earlier listing left there without a file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-stale-"));
  const artist = `Stale List ${process.pid}`;
  const title = `Stale ${process.pid}`;
  const titles = ["One", "You're in My Head", "Two", "Three"];
  const merged = { Three: [uuid("c1c1c1c1", 4)] };
  const album = listedAlbum(artist, uuid("dddddddd", 11), title, 110, titles, [{ id: uuid("bbbbbbbb", 110), titles, merged }]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await album.file(root, "One");
    await taggedTrack(root, artist, title, album, "Two (feat. Guest)", 3, uuid("c1c1c1c1", 3));
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
    assert.deepEqual(albumListing(title), [["One", "have"], ["You're in My Head", "missing"], ["Two (feat. Guest)", "have"], ["Three", "missing"]]);

    await taggedTrack(root, artist, title, album, "You'r in My Head", 2, uuid("c1c1c1c1", 2));
    await taggedTrack(root, artist, title, album, "Trois", 4, merged.Three[0]);
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
    assert.deepEqual(albumListing(title), [["One", "have"], ["You're in My Head", "have"], ["Two (feat. Guest)", "have"], ["Trois", "have"]]);
  });
});

test("a file is the listed song its recording is, before another whose title it shares at its place", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-recording-first-"));
  const artist = `Recording First List ${process.pid}`;
  const title = `Recording First ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 16), title, 160, ["Tonight", "Tonight, Tonight"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await taggedTrack(root, artist, title, album, "Tonight", 2, album.group.recordings.Tonight);
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title).sort(), [["Tonight, Tonight", "missing"], ["Tonight", "have"]]);
  });
});

test("a file tagged with a recording MusicBrainz merged into a release's song is that song, and counts toward its release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-merged-"));
  const artist = `Merged List ${process.pid}`;
  const title = `Merged ${process.pid}`;
  const remastered = { One: uuid("c2c2c2c2", 1), Two: uuid("c2c2c2c2", 2), Three: uuid("c2c2c2c2", 3), Bonus: uuid("c2c2c2c2", 4) };
  const merged = { One: [uuid("c3c3c3c3", 1)], Two: [uuid("c3c3c3c3", 2)] };
  const album = listedAlbum(artist, uuid("dddddddd", 12), title, 120, ["One", "Two"], [
    { id: uuid("bbbbbbbb", 120), titles: ["One", "Two"] },
    { id: uuid("bbbbbbbb", 121), titles: ["One", "Two"] },
    { id: uuid("bbbbbbbb", 122), titles: ["One", "Two", "Three", "Bonus"], recordings: remastered, merged },
  ]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await taggedTrack(root, artist, title, album, "One", 1, merged.One[0]);
  await taggedTrack(root, artist, title, album, "Two (LP Version)", 6, merged.Two[0]);
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title), [["One", "have"], ["Three", "missing"], ["Bonus", "missing"], ["Two (LP Version)", "have"]]);
  });
});

test("a tagged file numbered apart from its release is the release's song with its title, unless the release lists the title twice or another file has it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-tagged-apart-"));
  const artist = `Tagged Apart List ${process.pid}`;
  const title = `Tagged Apart ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 13), title, 130, ["When You Die", "Intro", "Song", "Intro", "Outro"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await taggedTrack(root, artist, title, album, "When You Die", 7, uuid("c4c4c4c4", 1));
  await taggedTrack(root, artist, title, album, "Intro", 8, uuid("c4c4c4c4", 2));
  await taggedTrack(root, artist, title, album, "Outro", 9, uuid("c4c4c4c4", 3));
  await taggedTrack(root, artist, title, album, "Outro", 10, uuid("c4c4c4c4", 4));
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title), [
      ["Intro", "missing"],
      ["Song", "missing"],
      ["Intro", "missing"],
      ["Outro", "missing"],
      ["When You Die", "have"],
      ["Intro", "have"],
      ["Outro", "have"],
      ["Outro", "have"],
    ]);
  });
});

test("a second file of a song, tagged with a recording its album's release does not list, is that song's with an untagged third through a full rescan, unless it is another version or at another song's place", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-copies-"));
  const artist = `Copies List ${process.pid}`;
  const title = `Copies ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 17), title, 170, ["Sex and Candy", "3 A.M.", "Kids", "Song"]);
  const scan = (force = false) => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false, force });
  const filesOf = (name) => db.prepare(
    `SELECT media.path FROM library_media_files AS media JOIN library_tracks AS track ON track.id = media.track_id
     WHERE track.title = ? AND media.available = 1 ORDER BY media.path`,
  ).pluck().all(name);
  const listed = [["3 A.M.", "have"], ["Kids (Live)", "have"], ["Kids", "missing"], ["Sex & Candy", "have"], ["Sex and Candy", "have"], ["Song", "missing"]];
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async (provider) => {
    provider.up = false;
    const untagged = await taggedTrack(root, artist, title, album, "3 AM", 2, "");
    await scan();
    const candy = [await album.file(root, "Sex and Candy"), await taggedTrack(root, artist, title, album, "Sex & Candy", 1, uuid("c5c5c5c5", 1))];
    const am = [await album.file(root, "3 A.M."), await taggedTrack(root, artist, title, album, "3AM", 2, uuid("c5c5c5c5", 2)), untagged];
    await taggedTrack(root, artist, title, album, "Kids (Live)", 3, uuid("c5c5c5c5", 3));
    await taggedTrack(root, artist, title, album, "Sex & Candy", 4, uuid("c5c5c5c5", 4));
    await scan();
    provider.up = true;
    await scan();

    assert.deepEqual(albumListing(title).sort(), listed);
    assert.deepEqual(filesOf("Sex and Candy"), candy.toSorted());
    assert.deepEqual(filesOf("3 A.M."), am.toSorted());

    await scan(true);
    assert.deepEqual(albumListing(title).sort(), listed);
    assert.deepEqual(filesOf("3 A.M."), am.toSorted());
  });
});

test("an album lists its release group only when the group holds one of its files, by recording and title when the group is another artist's", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-guessed-"));
  const artist = `Guessed List ${process.pid}`;
  const artistMbid = uuid("dddddddd", 14);
  const other = { artist: "Someone Else", artistMbid: uuid("dddddddd", 15) };
  const album = (name, index, titles) => listedAlbum(artist, artistMbid, `${name} ${process.pid}`, index, titles);
  const elsewhere = album("Elsewhere", 140, ["One", "Two"]);
  const merged = { One: [uuid("c6c6c6c6", 1)] };
  const renamed = listedAlbum(artist, artistMbid, `Renamed ${process.pid}`, 145, ["One", "Two"], [
    { id: uuid("bbbbbbbb", 145), titles: ["One", "Two"], merged },
  ]);
  const otherSong = album("Other Song", 141, ["One", "Two"]);
  const titleOnly = album("Title Only", 142, ["One", "Two"]);
  const featured = album("Featured", 143, ["One", "Two"]);
  const credited = album("Credited", 144, ["Duet", "Solo"]);
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await taggedTrack(root, artist, `Elsewhere ${process.pid}`, elsewhere, "Stranger", 1, "");
  await taggedTrack(root, artist, `Renamed ${process.pid}`, renamed, "Another Name", 1, merged.One[0]);
  await taggedTrack(root, artist, `Other Song ${process.pid}`, otherSong, "Main Theme", 1, otherSong.group.recordings.One);
  await taggedTrack(root, artist, `Title Only ${process.pid}`, titleOnly, "One", 1, "");
  await taggedTrack(root, artist, `Featured ${process.pid}`, featured, "One (feat. Guest)", 1, featured.group.recordings.One);
  await taggedTrack(root, artist, `Credited ${process.pid}`, credited, "Duet", 1, "");
  await withReleaseGroups({
    [elsewhere.releaseGroup]: elsewhere.group,
    [renamed.releaseGroup]: renamed.group,
    [otherSong.releaseGroup]: { ...otherSong.group, ...other },
    [titleOnly.releaseGroup]: { ...titleOnly.group, ...other },
    [featured.releaseGroup]: { ...featured.group, ...other },
    [credited.releaseGroup]: { ...credited.group, ...other, credits: [{ id: artistMbid, artistname: artist }] },
  }, async () => {
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(`Elsewhere ${process.pid}`), [["Stranger", "have"]]);
    assert.deepEqual(albumListing(`Renamed ${process.pid}`), [["Another Name", "have"], ["Two", "missing"]]);
    assert.deepEqual(albumListing(`Other Song ${process.pid}`), [["Main Theme", "have"]]);
    assert.deepEqual(albumListing(`Title Only ${process.pid}`), [["One", "have"]]);
    assert.deepEqual(albumListing(`Featured ${process.pid}`), [["One (feat. Guest)", "have"], ["Two", "missing"]]);
    assert.deepEqual(albumListing(`Credited ${process.pid}`), [["Duet", "have"], ["Solo", "missing"]]);
  });
});

test("an album someone asked for keeps the release it lists after its files are gone", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-gone-"));
  const artist = `Gone List ${process.pid}`;
  const title = `Gone ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 18), title, 180, ["One", "Two"]);
  const listedRelease = () => JSON.parse(db.prepare("SELECT metadata_json FROM library_albums WHERE title = ?").pluck().get(title)).trackList.release;
  t.after(async () => {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  });
  await withReleaseGroups({ [album.releaseGroup]: album.group }, async () => {
    const file = await album.file(root, "One");
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
    const albumId = db.prepare("SELECT id FROM library_albums WHERE title = ?").pluck().get(title);
    setLibraryManagement({ entityKind: "album", entityId: albumId, managedBy: "aurral", monitorMode: "monitored" });
    await rm(file);
    await scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

    assert.deepEqual(albumListing(title), [["One", "missing"], ["Two", "missing"]]);
    assert.equal(listedRelease(), uuid("bbbbbbbb", 180));
  });
});

test("an album the metadata provider does not know keeps its songs and does not stop the others being listed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-track-list-unknown-"));
  const artist = `Unknown List ${process.pid}`;
  const artistMbid = uuid("dddddddd", 2);
  const unknown = listedAlbum(artist, artistMbid, `Unknown ${process.pid}`, 20, ["Only"]);
  const known = [1, 2, 3, 4, 5, 6].map((index) => listedAlbum(artist, artistMbid, `Known ${index} ${process.pid}`, 20 + index, ["Have", "Want"]));
  const scan = () => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });
  try {
    await unknown.file(root, "Only", uuid("bbbbbbbb", 20));
    await withReleaseGroups(Object.fromEntries(known.map((album) => [album.releaseGroup, album.group])), async (provider) => {
      provider.up = false;
      await scan();
      for (const [index, album] of known.entries()) await album.file(root, "Have", uuid("bbbbbbbb", 21 + index));
      provider.up = true;
      await scan();

      assert.deepEqual(albumListing(`Unknown ${process.pid}`), [["Only", "have"]]);
      for (const index of [1, 2, 3, 4, 5, 6]) {
        assert.deepEqual(albumListing(`Known ${index} ${process.pid}`), [["Have", "have"], ["Want", "missing"]]);
      }
      const modified = getLibraryIndexLastModified();
      await scan();
      assert.equal(getLibraryIndexLastModified(), modified);
    });
  } finally {
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  }
});

test("an album lists the same songs, with the same ids, as Lidarr is turned off and on", async (t) => {
  const downloads = await mkdtemp(path.join(tmpdir(), "aurral-track-list-downloads-"));
  const music = await mkdtemp(path.join(tmpdir(), "aurral-track-list-music-"));
  const artist = `Switch List ${process.pid}`;
  const title = `Switch ${process.pid}`;
  const album = listedAlbum(artist, uuid("dddddddd", 3), title, 30, ["One", "Two", "Three"]);
  const release = uuid("bbbbbbbb", 30);
  t.after(async () => {
    removeArtistsNamed(artist);
    await Promise.all([downloads, music].map((root) => rm(root, { recursive: true, force: true })));
  });
  const lidarrOnly = listedAlbum(artist, uuid("dddddddd", 3), `Lidarr Only ${process.pid}`, 31, ["Kept"]);
  await album.file(downloads, "One", release);
  await album.file(music, "One", release);
  await album.file(music, "Two", release);
  await lidarrOnly.file(music, "Kept", uuid("bbbbbbbb", 31));
  const scan = (lidarrClient) => scanConfiguredLibrary({ musicRoot: downloads, lidarrClient, lidarrRoots: [music] });
  const listing = () => {
    const { id } = albumByTitle(title);
    return { id, tracks: db.prepare("SELECT track_id FROM library_album_tracks WHERE album_id = ? ORDER BY track_number").pluck().all(id), songs: albumListing(title) };
  };
  await withReleaseGroups({ [album.releaseGroup]: album.group, [lidarrOnly.releaseGroup]: lidarrOnly.group }, async () => {
    await scan(lidarrOn);
    const on = listing();
    assert.deepEqual(on.songs, [["One", "have"], ["Two", "have"], ["Three", "missing"]]);
    assert.deepEqual(albumListing(`Lidarr Only ${process.pid}`), [["Kept", "have"]]);

    await scan(lidarrOff);
    assert.deepEqual(listing(), { ...on, songs: [["One", "have"], ["Two", "missing"], ["Three", "missing"]] });
    assert.equal(albumByTitle(`Lidarr Only ${process.pid}`), undefined);

    await scan(lidarrOn);
    assert.deepEqual(listing(), on);
    assert.deepEqual(albumListing(`Lidarr Only ${process.pid}`), [["Kept", "have"]]);
    const modified = getLibraryIndexLastModified();
    await scan(lidarrOn);
    assert.equal(getLibraryIndexLastModified(), modified);
  });
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

test("MusicBrainz IDs tagged in capitals are the same IDs, other services' IDs are none, and rows an older scan keyed by them move with their favorites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-foreign-ids-"));
  const source = `test-foreign-ids-${process.pid}`;
  const artist = `Foreign Ids ${process.pid}`;
  const userId = 9600 + (process.pid % 300);
  const artistMbid = "2db9d3bf-c1da-45a9-a635-e19bdc3c1add";
  const groups = ["5a5dce64-e5b1-359c-96f6-fb4bebc4cf6c", "6b6edf75-f6c2-46ad-a7a7-ac5cfcd5d07d"];
  const recordings = ["c9824483-339f-4392-b7a9-2983ead513f4", "f5d74f4e-ebc0-4b1e-9d0c-1f2a3b4c5d6e", "e45cd7a6-64d1-4a2b-8c3d-4e5f6a7b8c9d", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"];
  const capitals = (id) => id.replace(/(^|-)([a-f])/g, (_, dash, letter) => dash + letter.toUpperCase());
  const deezer = "4246362661";
  const files = [
    { name: "Lack/01 One.flac", title: "One", group: capitals(groups[0]), recording: capitals(recordings[0]), artist: capitals(artistMbid),
      was: { artist: artistMbid, group: groups[0], track: `recording:${capitals(recordings[0])}` } },
    { name: "Lack/02 Two.flac", title: "Two", group: capitals(groups[0]), recording: capitals(recordings[1]), artist: capitals(artistMbid),
      was: { artist: artistMbid, group: capitals(groups[0]), track: `recording:${recordings[1]}` } },
    { name: "Lack/03 Four.flac", title: "Four", group: groups[0], recording: deezer, artist: artistMbid,
      was: { artist: artistMbid, group: groups[0], track: `recording:${deezer}` } },
    { name: "Pawn/01 Three.flac", title: "Three", group: groups[1], recording: recordings[2], artist: capitals(artistMbid),
      was: { artist: capitals(artistMbid), group: groups[1], track: `recording:${recordings[2]}` } },
    { name: "Violent Things/01 Five.flac", title: "Five", group: "", recording: recordings[3], artist: artistMbid,
      was: { artist: artistMbid, album: "1KLBdhphdiK82hYpAiw8DR", track: `recording:${recordings[3]}` } },
  ];
  for (const file of files) file.path = await createAudioFile(root, `${artist}/${file.name}`);
  const metadataReader = async (filePath) => {
    const file = files.find((entry) => entry.path === filePath);
    const metadata = untagged(artist, path.basename(path.dirname(filePath)), file.title, Number(path.basename(filePath).slice(0, 2)));
    Object.assign(metadata.common, {
      musicbrainz_albumartistid: [file.artist],
      musicbrainz_releasegroupid: file.group,
      musicbrainz_albumid: "1KLBdhphdiK82hYpAiw8DR",
      musicbrainz_recordingid: file.recording,
    });
    return metadata;
  };
  try {
    await withLibraryScan(source, root, async (scanId) => {
      for (const file of files) {
        const { size, mtimeMs } = await stat(file.path);
        const artistRow = upsertLibraryArtist({ identityKey: `mbid:${file.was.artist}`, mbid: file.was.artist, name: artist });
        const album = upsertLibraryAlbum({
          identityKey: file.was.group ? `release-group:${file.was.group}` : `album:${file.was.album}`,
          releaseGroupMbid: file.was.group || null,
          mbid: file.was.album || null,
          artistId: artistRow.id,
          title: path.dirname(file.name),
        });
        const track = upsertLibraryTrack({ identityKey: file.was.track, mbid: file.was.track.split(":")[1], title: file.title, artistName: artist });
        linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: Number(path.basename(file.name).slice(0, 2)) });
        upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source, path: file.path, format: "flac", size, mtimeMs, scanId });
      }
    });
    starFor(userId,
      ["album", `release-group:${capitals(groups[0])}`],
      ["artist", `mbid:${capitals(artistMbid)}`],
      ["song", `recording:${capitals(recordings[0])}`],
      ["song", `recording:${deezer}`]);

    await scanMusicRoot({ rootPath: root, source, metadataReader });

    const rows = files.map((file) => fileRows(source, file.path));
    assert.deepEqual(rows.slice(0, 4).map((row) => row.albumKey), [groups[0], groups[0], groups[0], groups[1]].map((id) => `release-group:${id}`));
    assert.match(rows[4].albumKey, /^name:/u);
    assert.deepEqual([0, 1, 3, 4].map((index) => rows[index].trackKey), recordings.map((id) => `recording:${id}`));
    assert.match(rows[2].trackKey, /^name:/u);
    assert.deepEqual(db.prepare("SELECT identity_key FROM library_artists WHERE name = ?").pluck().all(artist), [`mbid:${artistMbid}`]);
    assert.deepEqual(artistAlbums(artist).map((album) => album.identityKey), [...groups.map((id) => `release-group:${id}`), rows[4].albumKey]);
    assert.deepEqual(starredKeys(userId), [
      ["album", `release-group:${groups[0]}`],
      ["artist", `mbid:${artistMbid}`],
      ["song", rows[2].trackKey],
      ["song", `recording:${recordings[0]}`],
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) FROM library_tracks WHERE identity_key IN (?, ?)").pluck()
      .get(`recording:${capitals(recordings[0])}`, `recording:${deezer}`), 0);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    for (const file of files) deleteIndexedFile(source, file.path);
    removeArtistsNamed(artist);
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

test("a song whose file is gone leaves an album nobody asked for, and stays on one someone asked for", async () => {
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
  await file("Requested", "Kept", 1);
  const coming = await file("Requested", "Coming", 2);
  const lonely = await file("Unplugged", "Lonely", 1);
  const scan = () => scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => tags[filePath] });
  try {
    await scan();
    const catalogueTrack = upsertLibraryTrack({ identityKey: `missing:${process.pid}:difference`, title: "The Difference", monitored: true, syncSearch: false });
    linkLibraryAlbumTrack({ albumId: fileRows(source, headlight).albumId, trackId: catalogueTrack.id, trackNumber: 3, syncSearch: false });
    setLibraryManagement({ entityKind: "album", entityId: fileRows(source, coming).albumId, managedBy: "aurral", monitorMode: "monitored" });
    const comingTrack = fileRows(source, coming).trackId;
    for (const filePath of [lostCopy, marlenas, coming, lonely]) await rm(filePath);

    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Horse", 1], ["Requested", 2]]);
    assert.deepEqual(filesOnTrack(fileRows(source, headlight).trackId), [headlight]);
    assert.deepEqual(filesOnTrack(comingTrack), []);

    await file("Horse", "Three Marlenas", 2);
    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Horse", 2], ["Requested", 2]]);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder left empty, as by a disconnected drive, keeps its songs until the files come back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-unplugged-"));
  const source = `test-unplugged-${process.pid}`;
  const artist = `Unplugged ${process.pid}`;
  const tags = {};
  for (const [title, track] of [["Plugged", 1], ["In", 2]]) {
    tags[await createAudioFile(root, `${artist}/Drive/${track} ${title}.flac`)] = untagged(artist, "Drive", title, track);
  }
  const scan = () => scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => tags[filePath] });
  const rows = () => Object.keys(tags).map((filePath) => fileRows(source, filePath));
  const available = () => db.prepare("SELECT available FROM library_media_files WHERE source = ? ORDER BY path").pluck().all(source);
  try {
    await scan();
    const before = rows();
    await rm(path.join(root, artist), { recursive: true });
    await mkdir(path.join(root, "_flows"));

    await scan();

    assert.deepEqual(rows(), before);
    assert.deepEqual(available(), [0, 0]);

    for (const filePath of Object.keys(tags)) await createAudioFile(root, path.relative(root, filePath));
    await scan();

    assert.deepEqual(rows(), before);
    assert.deepEqual(available(), [1, 1]);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    removeArtistsNamed(artist);
    await rm(root, { recursive: true, force: true });
  }
});

test("an untagged track several albums list becomes each album's own tagged track for that album's files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-shared-untagged-"));
  const source = `test-shared-untagged-${process.pid}`;
  const elsewhere = `test-shared-untagged-elsewhere-${process.pid}`;
  const artist = `Shared Untagged ${process.pid}`;
  const tags = {};
  const first = await createAudioFile(root, `${artist}/First/01 Song.flac`);
  const second = await createAudioFile(root, `${artist}/Second/01 Song.flac`);
  tags[first] = tagged(artist, "First", "Song", 1, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e");
  tags[second] = tagged(artist, "Second", "Song", 1, "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f", "d4e5f6a7-b8c9-4d0e-8f2a-3b4c5d6e7f8a");
  const scan = () => scanMusicRoot({ rootPath: root, source, metadataReader: async (filePath) => tags[filePath] });
  const copies = [];
  try {
    await scan();
    const rows = [fileRows(source, first), fileRows(source, second)];
    const artistId = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").pluck().get(rows[0].albumId);
    const leftover = upsertLibraryAlbum({ identityKey: `name:album:shared untagged ${process.pid}`, artistId, title: "First", syncSearch: false });
    const shared = upsertLibraryTrack({ identityKey: `name:track:shared untagged ${process.pid}:song`, title: "Song", syncSearch: false });
    for (const albumId of [leftover.id, ...rows.map((row) => row.albumId)]) {
      linkLibraryAlbumTrack({ albumId, trackId: shared.id, discNumber: 1, trackNumber: 1, syncSearch: false });
    }
    for (const row of rows) {
      const copy = path.join(root, "elsewhere", `${row.albumId}.mp3`);
      upsertLibraryMediaFile({ trackId: shared.id, albumId: row.albumId, source: elsewhere, path: copy });
      copies.push(copy);
    }

    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["First", 1], ["Second", 1]]);
    assert.deepEqual(filesOnTrack(rows[0].trackId), [first, copies[0]].sort());
    assert.deepEqual(filesOnTrack(rows[1].trackId), [second, copies[1]].sort());
  } finally {
    for (const copy of copies) deleteIndexedFile(elsewhere, copy);
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a scan that removes an album moves the Library's last-modified time forward, so clients drop it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-removal-time-"));
  const artistName = `Removal Time ${process.pid}`;
  const artist = upsertLibraryArtist({ identityKey: `name:artist:removal time ${process.pid}`, name: artistName, syncSearch: false });
  upsertLibraryAlbum({ identityKey: `removal-time:${process.pid}`, artistId: artist.id, title: "Never Downloaded", syncSearch: false });
  const before = getLibraryIndexLastModified();
  try {
    await scanMusicRoot({ rootPath: root, source: `test-removal-time-${process.pid}` });

    assert.deepEqual(artistAlbums(artistName), []);
    assert.ok(getLibraryIndexLastModified() > before);
  } finally {
    removeArtistsNamed(artistName);
    await rm(root, { recursive: true, force: true });
  }
});

test("a file gone from an album someone asked for moves the Library's last-modified time forward", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-gone-time-"));
  const source = `test-gone-time-${process.pid}`;
  const artist = `Gone Time ${process.pid}`;
  const filePath = await createAudioFile(root, `${artist}/Requested/01 Song.flac`);
  const scan = () => scanMusicRoot({ rootPath: root, source, metadataReader: async () => untagged(artist, "Requested", "Song") });
  try {
    await scan();
    setLibraryManagement({ entityKind: "album", entityId: fileRows(source, filePath).albumId, managedBy: "aurral", monitorMode: "monitored" });
    const before = getLibraryIndexLastModified();
    await rm(filePath);

    await scan();

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Requested", 1]]);
    assert.ok(getLibraryIndexLastModified() > before);
  } finally {
    removeArtistsNamed(artist);
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

test("a rescan forgets files gone from a folder that still holds music, including ones an older scan only marked missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-reconcile-"));
  const source = `test-reconcile-${process.pid}`;
  const filePaths = [];
  try {
    for (const name of ["01 Track", "02 Marked", "03 Kept"]) filePaths.push(await createAudioFile(root, `Artist/Album/${name}.mp3`));
    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async (filePath) => songAt(filePath),
    });
    db.prepare("UPDATE library_media_files SET available = 0 WHERE source = ? AND path = ?").run(source, filePaths[1]);
    await rm(filePaths[0]);
    await rm(filePaths[1]);

    await scanMusicRoot({
      rootPath: root,
      source,
      metadataReader: async (filePath) => songAt(filePath),
    });
    const snapshot = getLibrarySnapshot();

    assert.deepEqual(snapshot.files.filter((file) => file.source === source).map((file) => file.path), [filePaths[2]]);
    assert.deepEqual(snapshot.tracks.filter((track) => /^0\d /.test(track.title)).map((track) => track.title), ["03 Kept"]);
  } finally {
    for (const filePath of filePaths) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a rescan leaves the songs of files it did not walk, in another folder or one it skips", async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), "aurral-library-scanned-")),
    mkdtemp(path.join(tmpdir(), "aurral-library-elsewhere-")),
  ]);
  const source = `test-elsewhere-${process.pid}`;
  const artist = `Elsewhere ${process.pid}`;
  const tags = {};
  try {
    for (const [root, album] of [[roots[0], "Scanned"], [roots[1], "Elsewhere"]]) {
      tags[await createAudioFile(root, `${artist}/${album}/01 Song.flac`)] = untagged(artist, album, "Song");
    }
    const reader = async (filePath) => tags[filePath];
    const skipped = await createAudioFile(roots[0], `_fallback/${artist}/Skipped/01 Song.flac`);
    tags[skipped] = untagged(artist, "Skipped", "Song");
    for (const root of roots) await scanMusicRoot({ rootPath: root, source, metadataReader: reader });
    await scanMusicRoot({ rootPath: roots[0], source, filePaths: [skipped], metadataReader: reader });

    await scanMusicRoot({ rootPath: roots[0], source, metadataReader: reader });

    assert.deepEqual(artistAlbums(artist).map(({ title, tracks }) => [title, tracks]), [["Elsewhere", 1], ["Scanned", 1], ["Skipped", 1]]);
  } finally {
    for (const filePath of Object.keys(tags)) deleteIndexedFile(source, filePath);
    removeArtistsNamed(artist);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
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

test("a targeted local rescan refreshes a named file even when its size and timestamp are unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-targeted-"));
  const source = `test-targeted-${process.pid}`;
  const filePaths = [];
  const metadataReads = [];
  let currentMetadata = metadata;
  const metadataReader = async (filePath) => {
    metadataReads.push(filePath);
    return currentMetadata;
  };
  try {
    filePaths.push(await createAudioFile(root, "Artist/Album/01 First.flac"));
    filePaths.push(await createAudioFile(root, "Artist/Album/02 Second.flac"));

    await scanMusicRoot({ rootPath: root, source, metadataReader });
    metadataReads.length = 0;
    currentMetadata = { ...metadata, common: { ...metadata.common, title: "Updated Step" } };
    const indexed = getLibrarySnapshot().files.find((file) => file.path === filePaths[0]);
    await utimes(filePaths[0], indexed.mtime_ms / 1000, indexed.mtime_ms / 1000);
    db.prepare("UPDATE library_media_files SET mtime_ms = ? WHERE source = ? AND path = ?")
      .run((await stat(filePaths[0])).mtimeMs, source, filePaths[0]);
    await scanMusicRoot({
      rootPath: root,
      source,
      changedPaths: [filePaths[0]],
      metadataReader,
    });

    assert.deepEqual(metadataReads, [filePaths[0]]);
    assert.equal(getLibrarySnapshot().tracks.find((track) => track.id === indexed.track_id).title, "Updated Step");
  } finally {
    for (const filePath of filePaths) deleteIndexedFile(source, filePath);
    await rm(root, { recursive: true, force: true });
  }
});

test("a targeted rescan forgets a deleted changed file", async () => {
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

    assert.equal(getLibrarySnapshot().files.some((file) => file.path === filePath), false);
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

test("a targeted directory rescan forgets only removed descendants", async () => {
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
    assert.deepEqual(files.filter((file) => filePaths.includes(file.path)).map((file) => [file.path, file.available]), [[filePaths[2], 1]]);
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

test("an album Lidarr manages stays in library reads when its files are all gone", async () => {
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
    assignLidarrAlbumOwners();
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
    removeArtistsNamed("Missing Album Artist");
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
