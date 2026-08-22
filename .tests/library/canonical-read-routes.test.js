import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { registerAlbums } from "../../backend/routes/library/handlers/albums.js";
import { registerTracks } from "../../backend/routes/library/handlers/tracks.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";

test("bounded backend callers do not materialize the compatibility library", async () => {
  const boundedCallers = [
    new URL("../../backend/routes/library/handlers/canonical.js", import.meta.url),
    new URL("../../backend/routes/library/handlers/downloads.js", import.meta.url),
    new URL("../../backend/services/libraryManager.js", import.meta.url),
    new URL("../../backend/services/storageHealthService.js", import.meta.url),
  ];

  for (const caller of boundedCallers) {
    const source = await readFile(caller, "utf8");
    assert.doesNotMatch(source, /\bgetCanonicalLibrary(?:ReadModel)?\s*\(/);
    assert.doesNotMatch(source, /\bbuildCanonicalLibraryReadModel\s*\(/);
  }
});

test("canonical track reads remove nested filesystem paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-canonical-route-"));
  const filePath = path.join(root, "Route Artist", "Route Album", "01 Route Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");

  try {
    await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{
          id: 701,
          artistName: "Route Artist",
          foreignArtistId: "71111111-1111-4111-8111-111111111111",
        }],
        getAllAlbums: async () => [{
          id: 702,
          artistId: 701,
          title: "Route Album",
          foreignAlbumId: "72222222-2222-4222-8222-222222222222",
          path: path.dirname(filePath),
        }],
        getTracksByAlbumId: async () => [{
          id: 703,
          albumId: 702,
          title: "Route Track",
          trackNumber: 1,
          foreignRecordingId: "73333333-3333-4333-8333-333333333333",
          trackFileId: 704,
        }],
        getTrackFilesByAlbumId: async () => [{
          id: 704,
          path: filePath,
          trackIds: [703],
          mediaInfo: {
            audioFormat: "FLAC",
            rootFolderPath: root,
            nested: { filePath },
          },
        }],
        getRootFolders: async () => [{ path: root }],
      },
    });

    const routes = new Map();
    registerTracks({
      delete(routePath, ...handlers) {
        routes.set(routePath, async (req, res) => {
          let index = 0;
          const next = () => {
            const handler = handlers[index++];
            return handler ? handler(req, res, next) : undefined;
          };
          return next();
        });
      },
      get(routePath, ...handlers) {
        routes.set(routePath, handlers.at(-1));
      },
    });

    let deleteStatus;
    let deleteBody;
    await routes.get("/tracks/:id")(
      { params: { id: "703" }, user: { role: "user", permissions: {} } },
      {
        status(code) {
          deleteStatus = code;
          return this;
        },
        json(value) {
          deleteBody = value;
          return this;
        },
      },
    );
    assert.equal(deleteStatus, 403);
    assert.equal(deleteBody.message, "Permission required: deleteTrack or deleteAlbum");

    let body;
    await routes.get("/tracks")(
      {
        query: {
          readPath: "canonical",
          releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
        },
      },
      {
        json(value) {
          body = value;
          return this;
        },
        status() {
          return this;
        },
      },
    );

    assert.equal(body.length, 1);
    assert.equal("path" in body[0], false);
    assert.deepEqual(body[0].quality, { audioFormat: "FLAC", nested: {} });
    assert.match(body[0].streamPath, /\/library\/canonical-stream\/\d+\/\d+$/);
    assert.equal(body[0].streamFormat, "flac");

    await routes.get("/tracks")(
      {
        query: {
          readPath: "canonical",
          albumId: "999999999",
          releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
        },
      },
      {
        json(value) {
          body = value;
          return this;
        },
        status() {
          return this;
        },
      },
    );
    assert.deepEqual(body.map((track) => track.title), ["Route Track"]);

    registerAlbums({
      get(routePath, ...handlers) {
        routes.set(routePath, handlers.at(-1));
      },
      post() {},
      delete() {},
      put() {},
    });
    const artist = db.prepare(
      "SELECT id, identity_key AS identityKey, mbid FROM library_artists WHERE mbid = ?",
    ).get("71111111-1111-4111-8111-111111111111");
    for (const artistId of [artist.id, artist.identityKey, artist.mbid]) {
      await routes.get("/albums")(
        { query: { readPath: "canonical", artistId } },
        {
          json(value) {
            body = value;
            return this;
          },
          status() {
            return this;
          },
        },
      );
      assert.deepEqual(body.map((album) => album.title), ["Route Album"]);
    }
  } finally {
    const track = db.prepare(
      "SELECT track_id AS trackId FROM library_media_files WHERE source = ? AND path = ?",
    ).get("lidarr", filePath);
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
    if (track) {
      const link = db.prepare(
        `SELECT album_track.album_id AS albumId, album.artist_id AS artistId
         FROM library_album_tracks AS album_track
         JOIN library_albums AS album ON album.id = album_track.album_id
         WHERE album_track.track_id = ?`,
      ).get(track.trackId);
      db.prepare("DELETE FROM library_album_tracks WHERE track_id = ?").run(track.trackId);
      db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.trackId);
      if (link) {
        db.prepare("DELETE FROM library_albums WHERE id = ?").run(link.albumId);
        db.prepare("DELETE FROM library_artists WHERE id = ?").run(link.artistId);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
