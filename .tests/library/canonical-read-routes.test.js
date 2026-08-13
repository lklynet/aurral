import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.js";
import { registerTracks } from "../../backend/routes/library/handlers/tracks.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";

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
      get(routePath, ...handlers) {
        routes.set(routePath, handlers.at(-1));
      },
    });

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
    assert.equal(body[0].streamPath, null);
    assert.equal(body[0].streamFormat, null);
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
