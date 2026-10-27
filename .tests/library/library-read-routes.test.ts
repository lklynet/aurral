import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/db-sqlite.ts";
import { api } from "../../backend/routes/api.ts";
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

    const asUser = signedInAs(testUser(1)).route("/", api);
    const asAdmin = signedInAs(testUser(1, { role: "admin" })).route("/", api);

    const deleted = await asUser.request("/library/tracks/703", { method: "DELETE" });
    assert.equal(deleted.status, 403);
    assert.equal((await deleted.json()).message, "Permission required: deleteTrack or deleteAlbum");

    let body: {
      id: number;
      title: string;
      quality: unknown;
      streamPath: string;
      streamFormat: string;
    }[] = await (
      await asUser.request(
        `/library/tracks?${new URLSearchParams({ readPath: "canonical", releaseGroupMbid })}`,
      )
    ).json();

    assert.equal(body.length, 1);
    assert.equal("path" in requireFixture(body)[0], false);
    assert.deepEqual(requireFixture(body)[0].quality, { audioFormat: "FLAC", nested: {} });
    assert.match(requireFixture(body)[0].streamPath, /\/library\/canonical-stream\/\d+\/\d+$/);
    assert.equal(requireFixture(body)[0].streamFormat, "flac");

    const filesPath = `/library/tracks/${requireFixture(body)[0].id}/files`;
    const userFiles = await asUser.request(filesPath);
    assert.equal(userFiles.status, 403);
    assert.equal((await userFiles.text()).includes(filePath), false);
    const adminFiles = await asAdmin.request(filesPath);
    assert.equal(adminFiles.status, 200);
    assert.deepEqual(await adminFiles.json(), { paths: [filePath] });
    assert.equal((await asAdmin.request("/library/tracks/999999999/files")).status, 404);

    body = await (
      await asUser.request(
        `/library/tracks?${new URLSearchParams({
          readPath: "canonical",
          albumId: "999999999",
          releaseGroupMbid,
        })}`,
      )
    ).json();
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
      body = await (
        await asUser.request(
          `/library/albums?${new URLSearchParams({ readPath: "canonical", artistId: String(artistId) })}`,
        )
      ).json();
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
