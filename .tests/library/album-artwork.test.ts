import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import { describe, test, beforeAll, afterAll, vi, type TestContext } from "vite-plus/test";
import fs, { access, mkdir, symlink, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { listen } from "../helpers/honoApp.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { createSession },
  { app },
  { buildPublicLibrary },
  libraryStore,
  { scanMusicRoot },
  { clearLibraryArtwork, getLibraryArtworkVersions, pruneLibraryArtwork },
] = await setupIsolatedBackend(
  "album-artwork",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/session-helpers.ts"),
  () => import("../../backend/app.ts"),
  () => import("../../backend/routes/library/handlers/libraryIndex.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/libraryArtwork.ts"),
);

const root = path.join(isolatedState.baseDir, "music");
await mkdir(root);
const solid = (background: "red" | "blue") =>
  sharp({ create: { width: 16, height: 16, channels: 3, background } })
    .png()
    .toBuffer();
const image = await solid("red");
const blue = await solid("blue");
const artist = libraryStore.upsertLibraryArtist({
  identityKey: "artwork-artist",
  name: "Artwork Artist",
});
dbOps.updateSettings({ onboardingComplete: true });

const realFetch = globalThis.fetch;
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
let session: { token: string; expiresAt: number } | null = null;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

type PublicLibraryAlbum = Parameters<typeof buildPublicLibrary>[0]["albums"][number];

const libraryAlbum = (overrides: Partial<PublicLibraryAlbum> & { coverUrl?: string }) => ({
  identityKey: "",
  mbid: null,
  releaseGroupMbid: null,
  artistId: artist.id,
  title: "",
  albumArtist: null,
  releaseDate: null,
  createdAt: 0,
  metadata: null,
  trackIds: [],
  sources: [],
  available: true,
  id: 0,
  ...overrides,
});

function audioWithPicture(picture: Buffer | null) {
  const audio = Buffer.alloc(417 * 2);
  audio.set([0xff, 0xfb, 0x90, 0x64], 0);
  audio.set([0xff, 0xfb, 0x90, 0x64], 417);
  if (!picture) return audio;
  const payload = Buffer.concat([Buffer.from("\0image/png\0\x03\0", "binary"), picture]);
  const frame = Buffer.alloc(10);
  frame.write("APIC");
  frame.writeUInt32BE(payload.length, 4);
  const size = frame.length + payload.length;
  const header = Buffer.from([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ]);
  return Buffer.concat([header, frame, payload, audio]);
}

async function albumFixture(
  name: string,
  pictures: (Buffer | null)[],
  albumFields: Partial<Parameters<typeof libraryStore.upsertLibraryAlbum>[0]> = {},
) {
  const folder = path.join(root, name);
  await mkdir(folder);
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: name,
    artistId: artist.id,
    title: name,
    ...albumFields,
  });
  for (const [index, picture] of pictures.entries()) {
    const filePath = path.join(folder, `${String(index).padStart(3, "0")}.mp3`);
    await writeFile(filePath, audioWithPicture(picture));
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `${name}:${index}`,
      title: `${index}`,
    });
    libraryStore.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      trackNumber: index + 1,
    });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: filePath,
      available: true,
    });
  }
  return { ...album, folder };
}

async function addArtworkAndScan(filePath: string, contents = image) {
  await writeFile(filePath, contents);
  await scanMusicRoot({ rootPath: root, changedPaths: [filePath] });
}

async function requestCover(
  albumId: string | number,
  {
    token = session?.token,
    headers = {},
    kind = "albums",
  }: {
    token?: string | null;
    headers?: { authorization?: string };
    kind?: "albums" | "artists";
  } = {},
) {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const response = await realFetch(`${baseUrl}/api/library/${kind}/${albumId}/cover${query}`, {
    headers,
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

const isBlue = async (body: Buffer) => {
  const { dominant } = await sharp(body).stats();
  return dominant.b > dominant.r;
};

function stubImageHost(t: TestContext, body: Buffer) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return new Response(new Uint8Array(body), { headers: { "content-type": "image/png" } });
  });
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return requests;
}

async function replaceFirstFile(album: { folder: string }, picture: Buffer | null) {
  const filePath = path.join(album.folder, "000.mp3");
  await writeFile(filePath, audioWithPicture(picture));
  const stat = await fs.stat(filePath);
  const file = requireFixture(
    db
      .prepare<[string], { track_id: number; album_id: number }>(
        "SELECT track_id, album_id FROM library_media_files WHERE path = ?",
      )
      .get(filePath),
  );
  libraryStore.upsertLibraryMediaFile({
    trackId: file.track_id,
    albumId: file.album_id,
    source: "aurral",
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

test("album cover URLs carry a version that changes when the album's files change", async () => {
  const album = await albumFixture("versioned", [image]);
  const version = getLibraryArtworkVersions("album", [album.id]).get(String(album.id));
  assert.match(requireFixture(version), /^[\da-f]{12}$/);

  const [publicAlbum] = buildPublicLibrary({
    artists: [],
    tracks: [],
    albums: [libraryAlbum({ id: album.id })],
  }).albums;
  assert.equal(publicAlbum.coverUrl, `/api/library/albums/${album.id}/cover?v=${version}`);

  await replaceFirstFile(album, blue);
  assert.notEqual(getLibraryArtworkVersions("album", [album.id]).get(String(album.id)), version);
});

test("clearing artwork gives covers new URLs so browsers fetch them again", async () => {
  const album = await albumFixture("cleared", [image]);
  const before = getLibraryArtworkVersions("album", [album.id]).get(String(album.id));
  await clearLibraryArtwork();
  assert.notEqual(getLibraryArtworkVersions("album", [album.id]).get(String(album.id)), before);
});

test("custom album artwork keeps the underlying embedded cover available as a fallback", () => {
  const albumId = 987654;
  db.prepare(`
    INSERT INTO custom_artwork (entity_kind, entity_id, content_type, source_url, updated_at)
    VALUES ('album', ?, 'image/webp', NULL, 1234)
  `).run(String(albumId));

  try {
    const [album] = buildPublicLibrary({
      artists: [],
      albums: [libraryAlbum({ id: albumId })],
      tracks: [],
    }).albums;

    assert.equal(album.coverUrl, `/api/library/artwork/album/${albumId}?v=1234`);
    assert.equal(album.customArtworkUrl, album.coverUrl);
    assert.equal(album.defaultCoverUrl, `/api/library/albums/${albumId}/cover`);
  } finally {
    db.prepare("DELETE FROM custom_artwork WHERE entity_kind = 'album' AND entity_id = ?").run(
      String(albumId),
    );
  }
});

test("installs without sign-in serve covers to requests without a token", async () => {
  const album = await albumFixture("no-sign-in", [image]);
  const result = await requestCover(album.id, { token: null });
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "image/webp");
});

describe("with sign-in required", () => {
  let user: NonNullable<ReturnType<typeof userOps.createUser>>;
  beforeAll(() => {
    user = requireFixture(userOps.createUser("artwork-test-user", "unused-hash", "user"));
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
    assert.match(requireFixture(result.cacheControl), /private/);
  });

  test("cover endpoint reads a differently cased sidecar and resizes it to fit 512 pixels", async () => {
    const album = await albumFixture("sidecar", [null]);
    await sharp({ create: { width: 1024, height: 768, channels: 3, background: "blue" } })
      .jpeg()
      .toFile(path.join(album.folder, "Cover.JPEG"));
    const result = await requestCover(album.id);
    assert.equal(result.status, 200);
    const metadata = await sharp(result.body).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 384);
  });

  test("cover endpoint accepts folder, front and album sidecars in any letter case", async () => {
    const sidecars = [
      ["Folder.jpg", "jpeg"],
      ["FRONT.webp", "webp"],
      ["album.png", "png"],
    ] as const;
    for (const [name, format] of sidecars) {
      const album = await albumFixture(`sidecar-${name}`, [null]);
      await sharp(image).toFormat(format).toFile(path.join(album.folder, name));
      assert.equal((await requestCover(album.id)).status, 200, name);
    }
  });

  test("cover endpoint refuses unknown albums, external sidecars and anonymous or invalid tokens", async () => {
    const bearer = { authorization: `Bearer ${requireFixture(session).token}` };
    assert.equal(
      (await requestCover("../etc/passwd", { token: null, headers: bearer })).status,
      404,
    );
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
      .png()
      .toFile(path.join(invalid.folder, "folder.png"));
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
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(
      Date.now() - 1,
      expired.token,
    );
    assert.equal((await requestCover(album.id, { token: expired.token })).status, 401);
    const disabled = userOps.createUser("disabled-artwork-user", "unused-hash", "user");
    assert.ok(disabled != null);
    const disabledSession = createSession(disabled.id);
    userOps.updateUser(disabled.id, { status: "disabled" });
    assert.equal((await requestCover(album.id, { token: disabledSession.token })).status, 401);
  });

  test("cover scan ignores unavailable files and inspects at most 100 indexed files", async () => {
    const unavailable = await albumFixture("unavailable", [image]);
    db.prepare("UPDATE library_media_files SET available = 0 WHERE album_id = ?").run(
      unavailable.id,
    );
    assert.equal((await requestCover(unavailable.id)).status, 404);
    const hundredth = await albumFixture("hundredth", [...Array(99).fill(null), image]);
    assert.equal((await requestCover(hundredth.id)).status, 200);
    const beyond = await albumFixture("beyond-limit", [...Array(100).fill(null), image]);
    assert.equal((await requestCover(beyond.id)).status, 404);
  });

  test("concurrent requests share one album lookup and missing artwork stays cached until a Library scan", async () => {
    const album = await albumFixture("missing-artwork-cache", [null, null]);
    const readdir = vi.spyOn(fs, "readdir");
    const albumReads = () => readdir.mock.calls.filter((call) => call[0] === album.folder).length;

    const results = await Promise.all(Array.from({ length: 5 }, () => requestCover(album.id)));
    assert.deepEqual(
      results.map((result) => result.status),
      [404, 404, 404, 404, 404],
    );
    assert.equal(albumReads(), 1);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.advanceTimersByTime(60 * 60 * 1000);
    assert.equal((await requestCover(album.id)).status, 404);
    assert.equal(albumReads(), 1);

    await addArtworkAndScan(path.join(album.folder, "cover.png"));
    assert.equal((await requestCover(album.id)).status, 200);
    assert.equal(albumReads(), 2);
  });
  test("an album's own file art wins over provider art", async (t) => {
    const requests = stubImageHost(t, blue);
    const album = await albumFixture("file-art-wins", [image], {
      metadata: { images: [{ remoteUrl: "https://images.example/file-art-wins.png" }] },
    });
    const result = await requestCover(album.id);
    assert.equal(result.status, 200);
    assert.equal(await isBlue(result.body), false);
    assert.deepEqual(requests, []);
  });

  test("provider art is downloaded once and then served from disk", async (t) => {
    const requests = stubImageHost(t, blue);
    const album = await albumFixture("provider-art", [null], {
      metadata: { images: [{ remoteUrl: "https://images.example/provider-art.png" }] },
    });
    const first = await requestCover(album.id);
    assert.equal(first.status, 200);
    assert.equal(await isBlue(first.body), true);
    assert.equal((await requestCover(album.id)).status, 200);
    assert.deepEqual(requests, ["https://images.example/provider-art.png"]);
  });

  test("a changed album file replaces the cached art", async () => {
    const album = await albumFixture("changed-file", [image]);
    assert.equal(await isBlue((await requestCover(album.id)).body), false);
    await replaceFirstFile(album, blue);
    assert.equal(await isBlue((await requestCover(album.id)).body), true);
  });

  test("a cover that vanishes before it is sent is not cached as missing for a year", async () => {
    const album = await albumFixture("vanishing", [image]);
    assert.equal((await requestCover(album.id)).status, 200);
    const version = requireFixture(
      getLibraryArtworkVersions("album", [album.id]).get(String(album.id)),
    );
    const stored = path.join(
      isolatedState.dataDir,
      "library-artwork",
      `album-${album.id}`,
      `${version}.webp`,
    );
    await fs.rm(stored);
    await mkdir(stored);
    const response = await realFetch(
      `${baseUrl}/api/library/albums/${album.id}/cover?v=${version}&token=${requireFixture(session).token}`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "private, max-age=300");
  });

  test("a slow lookup that finishes after a newer version keeps the newer art", async (t) => {
    const replies: ((response: Response) => void)[] = [];
    const waiters: (() => void)[] = [];
    const fetched = (count: number) =>
      replies.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push(resolve));
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          replies.push(resolve);
          waiters.splice(0).forEach((wake) => wake());
        }),
    );
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const reply = (index: number, body: Buffer) =>
      replies[index](
        new Response(new Uint8Array(body), { headers: { "content-type": "image/png" } }),
      );
    const album = await albumFixture("overlapping", [null], {
      metadata: { images: [{ remoteUrl: "https://images.example/overlapping.png" }] },
    });
    const stale = requestCover(album.id);
    await fetched(1);
    await replaceFirstFile(album, null);
    const current = requestCover(album.id);
    await fetched(2);
    reply(1, blue);
    assert.equal((await current).status, 200);
    reply(0, image);
    assert.equal((await stale).status, 200);

    const version = getLibraryArtworkVersions("album", [album.id]).get(String(album.id));
    const stored = await fs.readdir(
      path.join(isolatedState.dataDir, "library-artwork", `album-${album.id}`),
    );
    assert.ok(stored.some((name) => name.startsWith(`${version}.`)));
  });

  test("an artist without a provider photo shows its album's art", async () => {
    const photoless = libraryStore.upsertLibraryArtist({
      identityKey: "photoless-artist",
      name: "Photoless Artist",
    });
    const album = await albumFixture("photoless-album", [blue], { artistId: photoless.id });
    const result = await requestCover(photoless.id, { kind: "artists" });
    assert.equal(result.status, 200);
    assert.equal(await isBlue(result.body), true);

    await replaceFirstFile(album, image);
    assert.equal(await isBlue((await requestCover(photoless.id, { kind: "artists" })).body), false);
  });

  test("a failed artist photo lookup is retried instead of storing album art", async (t) => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const outage = libraryStore.upsertLibraryArtist({
      identityKey: "outage-artist",
      name: "Outage Artist",
      mbid: "1c5efd8c-8d4c-4d6c-9a43-1d9d0f2f1c11",
    });
    await albumFixture("outage-album", [blue], { artistId: outage.id });
    const result = await requestCover(outage.id, { kind: "artists" });
    assert.equal(result.status, 404);
    assert.equal(result.cacheControl, "private, max-age=300");
    await assert.rejects(
      access(path.join(isolatedState.dataDir, "library-artwork", `artist-${outage.id}`)),
    );
  });

  test("art for albums that leave the Library is pruned", async () => {
    const album = await albumFixture("pruned", [image]);
    assert.equal((await requestCover(album.id)).status, 200);
    const folder = path.join(isolatedState.dataDir, "library-artwork", `album-${album.id}`);
    await access(folder);
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    await pruneLibraryArtwork();
    await assert.rejects(access(folder));
  });
});
