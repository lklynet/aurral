import { requireFixture } from "../playlists/fixtures.ts";
import { Router, type Request, type Response, type RequestHandler } from "express";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.ts";
import { registerAlbums } from "../../backend/routes/library/handlers/albums.ts";
import { registerTracks } from "../../backend/routes/library/handlers/tracks.ts";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.ts";

test("library track reads remove nested filesystem paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-canonical-route-"));
  const filePath = path.join(root, "Route Artist", "Route Album", "01 Route Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");

  try {
    const artistMbid = "71111111-1111-4111-8111-111111111111";
    const releaseGroupMbid = "72222222-2222-4222-8222-222222222222";
    const recordingMbid = "73333333-3333-4333-8333-333333333333";
    const seededArtist = upsertLibraryArtist({
      identityKey: `mbid:${artistMbid}`,
      mbid: artistMbid,
      name: "Route Artist",
    });
    const seededAlbum = upsertLibraryAlbum({
      identityKey: `release-group:${releaseGroupMbid}`,
      mbid: releaseGroupMbid,
      releaseGroupMbid,
      artistId: seededArtist.id,
      title: "Route Album",
      albumArtist: "Route Artist",
    });
    const seededTrack = upsertLibraryTrack({
      identityKey: `recording:${recordingMbid}`,
      mbid: recordingMbid,
      title: "Route Track",
      artistName: "Route Artist",
    });
    linkLibraryAlbumTrack({ albumId: seededAlbum.id, trackId: seededTrack.id, trackNumber: 1 });
    upsertLibraryMediaFile({
      trackId: seededTrack.id,
      albumId: seededAlbum.id,
      source: "lidarr",
      path: filePath,
      format: "flac",
      size: 7,
      quality: {
        audioFormat: "FLAC",
        rootFolderPath: root,
        nested: { filePath },
      },
    });

    const router = Router();
    registerAlbums(router);
    registerTracks(router);
    const routeChains = new Map<string, RequestHandler[]>();
    const routes = new Map<string, (request: object, response: object) => unknown>();
    for (const layer of router.stack) {
      const route = layer.route;
      if (
        !route ||
        !route.stack.some(
          (entry: { method: string }) => entry.method === "get" || entry.method === "delete",
        )
      )
        continue;
      const handlers: RequestHandler[] = route.stack.map(
        (entry: { handle: RequestHandler }) => entry.handle,
      );
      routeChains.set(route.path, handlers);
      routes.set(route.path, (req, res) => {
        Object.assign(req, { headers: {}, user: { role: "user", permissions: {} }, ...req });
        let index = 0;
        const next = (): unknown => handlers[index++]?.(req as Request, res as Response, next);
        return next();
      });
    }

    const getTrackFiles = async (id: string, user: { role: string; permissions?: object }) => {
      const response = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(value: unknown) {
          this.body = value;
          return this;
        },
        set() {
          return this;
        },
        setHeader() {},
      };
      const handlers = requireFixture(routeChains.get("/tracks/:id/files"));
      let index = 0;
      const next = (): unknown =>
        handlers[index++]?.(
          { params: { id }, user } as unknown as Request,
          response as unknown as Response,
          next,
        );
      await next();
      return response;
    };

    let deleteStatus;
    let deleteBody: { message: string } | undefined;
    await requireFixture(routes.get("/tracks/:id"))(
      { params: { id: "703" }, user: { role: "user", permissions: {} } },
      {
        status(code: number) {
          deleteStatus = code;
          return this;
        },
        json(value: { message: string }) {
          deleteBody = value;
          return this;
        },
      },
    );
    assert.equal(deleteStatus, 403);
    assert.equal(
      requireFixture(deleteBody).message,
      "Permission required: deleteTrack or deleteAlbum",
    );

    let body: {
      id: number;
      title: string;
      quality: unknown;
      streamPath: string;
      streamFormat: string;
    }[] = [];
    await requireFixture(routes.get("/tracks"))(
      {
        query: {
          readPath: "canonical",
          releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
        },
      },
      {
        json(value: typeof body) {
          body = value;
          return this;
        },
        status() {
          return this;
        },
      },
    );

    assert.equal(body.length, 1);
    assert.equal("path" in requireFixture(body)[0], false);
    assert.deepEqual(requireFixture(body)[0].quality, { audioFormat: "FLAC", nested: {} });
    assert.match(requireFixture(body)[0].streamPath, /\/library\/canonical-stream\/\d+\/\d+$/);
    assert.equal(requireFixture(body)[0].streamFormat, "flac");

    const userFiles = await getTrackFiles(String(requireFixture(body)[0].id), {
      role: "user",
      permissions: {},
    });
    assert.equal(userFiles.statusCode, 403);
    assert.equal(JSON.stringify(userFiles.body).includes(filePath), false);
    const adminFiles = await getTrackFiles(String(requireFixture(body)[0].id), { role: "admin" });
    assert.equal(adminFiles.statusCode, 200);
    assert.deepEqual(adminFiles.body, { paths: [filePath] });
    assert.equal((await getTrackFiles("999999999", { role: "admin" })).statusCode, 404);

    await requireFixture(routes.get("/tracks"))(
      {
        query: {
          readPath: "canonical",
          albumId: "999999999",
          releaseGroupMbid: "72222222-2222-4222-8222-222222222222",
        },
      },
      {
        json(value: typeof body) {
          body = value;
          return this;
        },
        status() {
          return this;
        },
      },
    );
    assert.deepEqual(
      requireFixture(body).map((track) => track.title),
      ["Route Track"],
    );

    const artist = db
      .prepare<unknown[], { id: number; identityKey: string; mbid: string | null }>(
        "SELECT id, identity_key AS identityKey, mbid FROM library_artists WHERE mbid = ?",
      )
      .get("71111111-1111-4111-8111-111111111111");
    for (const artistId of [
      requireFixture(artist).id,
      requireFixture(artist).identityKey,
      requireFixture(artist).mbid,
    ]) {
      await requireFixture(routes.get("/albums"))(
        { query: { readPath: "canonical", artistId } },
        {
          json(value: typeof body) {
            body = value;
            return this;
          },
          status() {
            return this;
          },
        },
      );
      assert.ok(Array.isArray(body), JSON.stringify(body));
      assert.deepEqual(
        requireFixture(body).map((album) => album.title),
        ["Route Album"],
      );
    }
  } finally {
    const track = db
      .prepare<unknown[], { trackId: number }>(
        "SELECT track_id AS trackId FROM library_media_files WHERE source = ? AND path = ?",
      )
      .get("lidarr", filePath);
    db.prepare("DELETE FROM library_media_files WHERE source = ? AND path = ?").run(
      "lidarr",
      filePath,
    );
    if (track) {
      const link = db
        .prepare<unknown[], { albumId: number; artistId: number }>(
          `SELECT album_track.album_id AS albumId, album.artist_id AS artistId
         FROM library_album_tracks AS album_track
         JOIN library_albums AS album ON album.id = album_track.album_id
         WHERE album_track.track_id = ?`,
        )
        .get(track.trackId);
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
