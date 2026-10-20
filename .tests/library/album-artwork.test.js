import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fs, { mkdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { createSession },
  { authMiddleware },
  { default: libraryRouter },
  { buildPublicLibrary },
  libraryStore,
  { scanMusicRoot },
] = await setupIsolatedBackend(
  "album-artwork",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/config/session-helpers.js",
  "backend/middleware/auth.js",
  "backend/routes/library/index.js",
  "backend/routes/library/handlers/libraryIndex.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryFileScanner.js",
);

const root = path.join(isolatedState.baseDir, "music");
await mkdir(root);
const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } })
  .png().toBuffer();
const artist = libraryStore.upsertLibraryArtist({ identityKey: "artwork-artist", name: "Artwork Artist" });
dbOps.updateSettings({ onboardingComplete: true });

const app = express();
app.use(authMiddleware);
app.use("/api/library", libraryRouter);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let session = null;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

function audioWithPicture(picture) {
  const audio = Buffer.alloc(417 * 2);
  audio.set([0xff, 0xfb, 0x90, 0x64], 0);
  audio.set([0xff, 0xfb, 0x90, 0x64], 417);
  if (!picture) return audio;
  const payload = Buffer.concat([Buffer.from("\0image/png\0\x03\0", "binary"), picture]);
  const frame = Buffer.alloc(10);
  frame.write("APIC");
  frame.writeUInt32BE(payload.length, 4);
  const size = frame.length + payload.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
    (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([header, frame, payload, audio]);
}

async function albumFixture(name, pictures) {
  const folder = path.join(root, name);
  await mkdir(folder);
  const album = libraryStore.upsertLibraryAlbum({ identityKey: name, artistId: artist.id, title: name });
  for (const [index, picture] of pictures.entries()) {
    const filePath = path.join(folder, `${String(index).padStart(3, "0")}.mp3`);
    await writeFile(filePath, audioWithPicture(picture));
    const track = libraryStore.upsertLibraryTrack({ identityKey: `${name}:${index}`, title: `${index}` });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id, albumId: album.id, source: "aurral", path: filePath, available: true,
    });
  }
  return { ...album, folder };
}

async function addArtworkAndScan(filePath, contents = image) {
  await writeFile(filePath, contents);
  await scanMusicRoot({ rootPath: root, changedPaths: [filePath] });
}

async function requestCover(albumId, { token = session?.token, headers = {} } = {}) {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const response = await fetch(`${baseUrl}/api/library/albums/${albumId}/cover${query}`, { headers });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

test("only available unidentified albums gain a local cover URL and remote artwork stays preferred", () => {
  const albums = buildPublicLibrary({ artists: [], tracks: [], albums: [
    { id: 12, available: true },
    { id: 13, available: true, coverUrl: "/existing-cover.webp" },
    { id: 14, available: false },
    { id: 15, available: true, releaseGroupMbid: "release-group" },
    { id: 16, available: true, mbid: "release" },
    { id: 17, available: true, metadata: { images: [{ remoteUrl: "https://example.invalid/cover.jpg" }] } },
  ] }).albums;
  assert.equal(albums[0].coverUrl, "/api/library/albums/12/cover");
  assert.equal(albums[1].coverUrl, "/existing-cover.webp");
  assert.equal(albums[2].coverUrl, null);
  assert.equal(albums[3].coverUrl, null);
  assert.equal(albums[4].coverUrl, null);
  assert.equal(albums[5].coverUrl, "https://example.invalid/cover.jpg");
});

test("custom album artwork keeps the underlying embedded cover available as a fallback", () => {
  const albumId = "custom-cover-fallback";
  db.prepare(`
    INSERT INTO custom_artwork (entity_kind, entity_id, content_type, source_url, updated_at)
    VALUES ('album', ?, 'image/webp', NULL, 1234)
  `).run(albumId);

  try {
    const [album] = buildPublicLibrary({
      artists: [],
      albums: [{ id: albumId, available: true }],
      tracks: [],
    }).albums;

    assert.equal(album.coverUrl, `/api/library/artwork/album/${albumId}?v=1234`);
    assert.equal(album.customArtworkUrl, album.coverUrl);
    assert.equal(album.defaultCoverUrl, `/api/library/albums/${albumId}/cover`);
  } finally {
    db.prepare("DELETE FROM custom_artwork WHERE entity_kind = 'album' AND entity_id = ?")
      .run(albumId);
  }
});

test("installs without sign-in serve covers to requests without a token", async () => {
  const album = await albumFixture("no-sign-in", [image]);
  const result = await requestCover(album.id, { token: null });
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "image/webp");
});

describe("with sign-in required", () => {
  let user;
  before(() => {
    user = userOps.createUser("artwork-test-user", "unused-hash", "user");
    session = createSession(user.id);
  });

  test("cover endpoint finds embedded artwork on a later indexed track and returns private WebP", async () => {
    const album = await albumFixture("embedded", [null, image]);
    const result = await requestCover(album.id);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "image/webp");
    const metadata = await sharp(result.body).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 16);
    assert.match(result.cacheControl, /private/);
  });

  test("cover endpoint reads a differently cased sidecar and resizes it to fit 512 pixels", async () => {
    const album = await albumFixture("sidecar", [null]);
    await sharp({ create: { width: 1024, height: 768, channels: 3, background: "blue" } })
      .jpeg().toFile(path.join(album.folder, "Cover.JPEG"));
    const result = await requestCover(album.id);
    assert.equal(result.status, 200);
    const metadata = await sharp(result.body).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 384);
  });

  test("cover endpoint accepts folder, front and album sidecars in any letter case", async () => {
    for (const name of ["Folder.jpg", "FRONT.webp", "album.png"]) {
      const album = await albumFixture(`sidecar-${name}`, [null]);
      const format = path.extname(name).slice(1).toLowerCase().replace("jpg", "jpeg");
      await sharp(image).toFormat(format).toFile(path.join(album.folder, name));
      assert.equal((await requestCover(album.id)).status, 200, name);
    }
  });

  test("cover endpoint refuses unknown albums, external sidecars and anonymous or invalid tokens", async () => {
    const bearer = { authorization: `Bearer ${session.token}` };
    assert.equal((await requestCover("../etc/passwd", { token: null, headers: bearer })).status, 404);
    assert.equal((await requestCover(999999)).status, 404);
    const album = await albumFixture("symlink", [null]);
    const outside = path.join(root, "private.png");
    await writeFile(outside, image);
    await symlink(outside, path.join(album.folder, "cover.png"));
    assert.equal((await requestCover(album.id)).status, 404);
    assert.equal((await requestCover(album.id, { token: null })).status, 401);
    assert.equal((await requestCover(album.id, { token: "invalid-token" })).status, 401);
    await addArtworkAndScan(path.join(album.folder, "folder.png"));
    assert.equal((await requestCover(album.id, { token: null, headers: bearer })).status, 200);
  });

  test("sidecars that are invalid, outside the image allowlist or over byte or pixel limits are skipped", async () => {
    const invalid = await albumFixture("invalid", [null]);
    await sharp(image).tiff().toFile(path.join(invalid.folder, "cover.jpg"));
    await writeFile(path.join(invalid.folder, "cover.jpeg"), "invalid image");
    const oversized = path.join(invalid.folder, "cover.png");
    await writeFile(oversized, image);
    await truncate(oversized, 25 * 1024 * 1024 + 1);
    await sharp({ create: { width: 8001, height: 5000, channels: 3, background: "red" } })
      .png().toFile(path.join(invalid.folder, "folder.png"));
    assert.equal((await requestCover(invalid.id)).status, 404);

    const limit = await albumFixture("byte-limit", [null]);
    const atLimit = path.join(limit.folder, "cover.png");
    await writeFile(atLimit, image);
    await truncate(atLimit, 25 * 1024 * 1024);
    assert.equal((await requestCover(limit.id)).status, 200);
  });

  test("cover endpoint rejects expired sessions and disabled user accounts", async () => {
    const album = await albumFixture("session", [image]);
    const expired = createSession(user.id);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, expired.token);
    assert.equal((await requestCover(album.id, { token: expired.token })).status, 401);
    const disabled = userOps.createUser("disabled-artwork-user", "unused-hash", "user");
    const disabledSession = createSession(disabled.id);
    userOps.updateUser(disabled.id, { status: "disabled" });
    assert.equal((await requestCover(album.id, { token: disabledSession.token })).status, 401);
  });

  test("cover scan ignores unavailable files and inspects at most 100 indexed files", async () => {
    const unavailable = await albumFixture("unavailable", [image]);
    db.prepare("UPDATE library_media_files SET available = 0 WHERE album_id = ?").run(unavailable.id);
    assert.equal((await requestCover(unavailable.id)).status, 404);
    const hundredth = await albumFixture("hundredth", [...Array(99).fill(null), image]);
    assert.equal((await requestCover(hundredth.id)).status, 200);
    const beyond = await albumFixture("beyond-limit", [...Array(100).fill(null), image]);
    assert.equal((await requestCover(beyond.id)).status, 404);
  });

  test("concurrent requests share one album lookup and missing artwork stays cached until a Library scan", async (t) => {
    const album = await albumFixture("missing-artwork-cache", [null, null]);
    const readdir = t.mock.method(fs, "readdir");
    const albumReads = () => readdir.mock.calls.filter((call) => call.arguments[0] === album.folder).length;

    const results = await Promise.all(Array.from({ length: 5 }, () => requestCover(album.id)));
    assert.deepEqual(results.map((result) => result.status), [404, 404, 404, 404, 404]);
    assert.equal(albumReads(), 1);

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(60 * 60 * 1000);
    assert.equal((await requestCover(album.id)).status, 404);
    assert.equal(albumReads(), 1);

    await addArtworkAndScan(path.join(album.folder, "cover.png"));
    assert.equal((await requestCover(album.id)).status, 200);
    assert.equal(albumReads(), 2);
  });
});
