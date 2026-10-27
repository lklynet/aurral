import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import express from "express";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const fakeBin = await mkdtemp(path.join(tmpdir(), "aurral-fake-cloudflared-"));
const launchLog = path.join(fakeBin, "launches.jsonl");
await writeFile(
  path.join(fakeBin, "cloudflared"),
  `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") process.exit(0);
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
const launches = fs.readFileSync(${JSON.stringify(launchLog)}, "utf8").trim().split("\\n").length;
console.error("INF |  https://fake-tunnel-" + launches + ".trycloudflare.com  |");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
);
await chmod(path.join(fakeBin, "cloudflared"), 0o755);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

type LookupEntry = { method?: string; url?: string; body: { secret: string; url: string } | null };
const lookupRequests: LookupEntry[] = [];
const lookupWaiters = new Set<(entry: LookupEntry) => void>();
let lookupStatus = 204;
let resolvedManifest: unknown = null;
const lookup = await createMockHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const entry = {
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null,
    };
    lookupRequests.push(entry);
    for (const waiter of lookupWaiters) waiter(entry);
    if (request.url?.startsWith("/api/shares/resolve?") && resolvedManifest) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ manifest: resolvedManifest, files: null }));
      return;
    }
    response.statusCode = lookupStatus;
    response.end();
  });
});
process.env.AURRAL_SHARE_ORIGIN = lookup.url;

function nextLookup(predicate: (entry: LookupEntry) => boolean) {
  const existing = lookupRequests.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<LookupEntry>((resolve) => {
    const waiter = (entry: LookupEntry) => {
      if (!predicate(entry)) return;
      lookupWaiters.delete(waiter);
      resolve(entry);
    };
    lookupWaiters.add(waiter);
  });
}

async function launches() {
  const text = await readFile(launchLog, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const [paths, { db }, { userOps }, listener, routes, media, remote] = await setupIsolatedBackend(
  "share-links",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/shareLinks/shareListener.ts"),
  () => import("../../backend/routes/shareLinks.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/shareLinks/remote.ts"),
);

const ARTIST_MBID = "71111111-1111-4111-8111-111111111111";
const FIRST_ALBUM_MBID = "72222222-2222-4222-8222-222222222222";
const SECOND_ALBUM_MBID = "73333333-3333-4333-8333-333333333333";
const OTHER_ARTIST_MBID = "74444444-4444-4444-8444-444444444444";
const PAYLOAD = "AQIDdGVzdA";

const owner = userOps.createUser("sharer", "hash");
assert.ok(owner != null);
const stranger = userOps.createUser("stranger", "hash");

async function seedFile(relativePath: string, size: number) {
  const filePath = path.join(paths.baseDir, "music", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = crypto.randomBytes(size);
  await writeFile(filePath, bytes);
  return { filePath, bytes };
}

async function seedAlbum({
  artist,
  mbid,
  title,
  tracks,
}: {
  artist: import("../../backend/db/rows.ts").LibraryArtistsRow;
  mbid: string;
  title: string;
  tracks: {
    title: string;
    number: number;
    file: string;
    disc?: number;
    size?: number;
    source?: string;
  }[];
}) {
  const album = media.upsertLibraryAlbum({
    identityKey: `release-group:${mbid}`,
    mbid,
    releaseGroupMbid: mbid,
    artistId: artist.id,
    title,
    albumArtist: artist.name,
  });
  const seeded = [];
  for (const spec of tracks) {
    const track = media.upsertLibraryTrack({
      identityKey: `track:${title}:${spec.title}`,
      title: spec.title,
      artistName: artist.name,
    });
    media.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      discNumber: spec.disc || 1,
      trackNumber: spec.number,
    });
    const file = await seedFile(`${artist.name}/${title}/${spec.file}`, spec.size || 4096);
    media.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: spec.source || "lidarr",
      path: file.filePath,
      format: path.extname(spec.file).slice(1),
      size: file.bytes.length,
    });
    seeded.push({ ...spec, albumId: album.id, trackId: track.id, bytes: file.bytes });
  }
  return { album, tracks: seeded };
}

const artist = media.upsertLibraryArtist({
  identityKey: `mbid:${ARTIST_MBID}`,
  mbid: ARTIST_MBID,
  name: "Share Artist",
});
const otherArtist = media.upsertLibraryArtist({
  identityKey: `mbid:${OTHER_ARTIST_MBID}`,
  mbid: OTHER_ARTIST_MBID,
  name: "Other Artist",
});
const firstAlbum = await seedAlbum({
  artist,
  mbid: FIRST_ALBUM_MBID,
  title: "First Album",
  tracks: [
    { title: "Second Song", number: 2, file: "02 Second Song.flac" },
    { title: "Disc Two Song", number: 1, disc: 2, file: "2-01 Disc Two Song.mp3" },
    { title: "Opening Song", number: 1, file: "01 Opening Song.flac", size: 70000 },
    { title: "Flow Song", number: 3, file: "03 Flow Song.mp3", source: "flow" },
  ],
});
const secondAlbum = await seedAlbum({
  artist,
  mbid: SECOND_ALBUM_MBID,
  title: "Second Album",
  tracks: [{ title: "Later Song", number: 1, file: "01 Later Song.flac" }],
});
await seedAlbum({
  artist: otherArtist,
  mbid: "75555555-5555-4555-8555-555555555555",
  title: "Elsewhere",
  tracks: [{ title: "Unrelated", number: 1, file: "01 Unrelated.flac" }],
});

const localArtist = media.upsertLibraryArtist({
  identityKey: "name:home recorder",
  name: "Home Recorder",
});
await seedAlbum({
  artist: localArtist,
  mbid: "76666666-6666-4666-8666-666666666666",
  title: "Demos",
  tracks: [{ title: "Basement Take", number: 1, file: "01 Basement Take.flac" }],
});

const api = express();
api.use(express.json());
api.use((req, res, next) => {
  const userId = Number(req.get("x-test-user"));
  req.user = userId === 0 ? { ...owner, id: 0 } : userOps.getUserById(userId) || undefined;
  next();
});
api.use("/api/share-links", routes.default);
const apiServer = await new Promise<
  import("node:http").Server<
    typeof import("node:http").IncomingMessage,
    typeof import("node:http").ServerResponse
  >
>((resolve) => {
  const server = api.listen(0, "127.0.0.1", () => resolve(server));
});
const apiUrl = `http://127.0.0.1:${listeningAddress(apiServer).port}/api/share-links`;

afterAll(async () => {
  await listener.stopShareListener();
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await lookup.close();
  await cleanupIsolatedState(paths);
  await rm(fakeBin, { recursive: true, force: true });
});

beforeEach(async () => {
  db.prepare("DELETE FROM share_links").run();
  await listener.syncShareListener();
  await writeFile(launchLog, "");
  lookupRequests.length = 0;
  lookupStatus = 204;
  resolvedManifest = null;
});

test("a pasted share code resolves to the same link as its URL", () => {
  const link = `${process.env.AURRAL_SHARE_ORIGIN}/s/sAbc123_def-456`;
  assert.equal(remote.normalizeShareUrl(" sAbc123_def-456 "), link);
  assert.equal(remote.normalizeShareUrl(link), link);
  assert.throws(() => remote.normalizeShareUrl("https://example.com/s/sAbc123_def-456"));
  assert.throws(() => remote.normalizeShareUrl("../sAbc123"));
});

test("opening a share is available without import permissions or an account and queues no downloads", async () => {
  resolvedManifest = {
    kind: "album",
    title: firstAlbum.album.title,
    artistName: artist.name,
    albumMbid: FIRST_ALBUM_MBID,
  };
  for (const user of [stranger, { ...owner, id: 0 }]) {
    const result = await callApi("POST", "/open", {
      user,
      body: { url: `${lookup.url}/s/s123456789abcdef` },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.to, `/library/album/${firstAlbum.album.id}`);
  }
  assert.equal(db.prepare("SELECT 1 FROM share_links LIMIT 1").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM playlist_download_jobs LIMIT 1").get(), undefined);
});

async function callApi(
  method: string,
  url: string,
  { user = owner, body }: { user?: typeof owner; body?: unknown } = {},
) {
  assert.ok(user != null);
  const response = await fetch(`${apiUrl}${url}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": String(user.id) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createLink(
  item: {
    kind: string;
    id?: string | number;
    albumMbid?: string;
    artistMbid?: string;
    libraryTrackId?: number;
    libraryArtistId?: string;
  },
  options: { allowDownload?: boolean; expiresIn?: string } = {},
) {
  const response = await callApi("POST", "", {
    body: { ...item, payload: PAYLOAD, allowDownload: false, expiresIn: "7d", ...options },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.link;
}

const tokenOf = (link: { url: string }) => {
  const segment = new URL(link.url).pathname.slice(3);
  if (/^s[A-Za-z0-9_-]{15}$/.test(segment))
    return requireFixture(
      db
        .prepare<[string], { token: string }>(
          "SELECT token FROM share_links WHERE substr(token, 1, 15) = ?",
        )
        .get(segment.slice(1)),
    ).token;
  return link.url.split(".").at(-1);
};

async function tunnelTarget() {
  await nextLookup(
    (entry) => entry.method === "PUT" && entry.url?.startsWith("/api/instances/") === true,
  );
  const latest = (await launches()).at(-1);
  assert.ok(latest && isRunning(latest.pid), "cloudflared should run while a link is live");
  return latest.args[latest.args.indexOf("--url") + 1];
}

async function shareUrl(link: { url: string }, suffix: string = "") {
  return `${await tunnelTarget()}/share/${tokenOf(link)}${suffix}`;
}

function readZip(buffer: Buffer<ArrayBuffer>) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer<ArrayBuffer> }[] = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    assert.equal(zlib.crc32(data), crc, `CRC for ${name}`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("an album link plays only that album's Library files, in disc and track order", async () => {
  const link = await createLink({ kind: "album", albumMbid: FIRST_ALBUM_MBID });
  assert.ok(link.url.startsWith(`${lookup.url}/s/AQIDdGVzdA~`), link.url);
  assert.match(link.url, /~[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(link.title, "First Album");

  const share = await (await fetch(await shareUrl(link))).json();
  assert.deepEqual(
    share.tracks.map((track: { title: string; path: string }) => track.title),
    ["Opening Song", "Second Song", "Disc Two Song"],
  );
  assert.equal(share.allowDownload, false);

  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  assert.ok(opening != null);
  const ranged = await fetch(
    await shareUrl(link, `/tracks/${opening.albumId}/${opening.trackId}/stream`),
    {
      headers: { Range: "bytes=100-199" },
    },
  );
  assert.equal(ranged.status, 206);
  assert.ok(opening != null);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), opening.bytes.subarray(100, 200));

  const flow = firstAlbum.tracks.find((track) => track.title === "Flow Song");
  const later = secondAlbum.tracks[0];
  for (const track of [flow, later]) {
    assert.ok(track != null);
    const response = await fetch(
      await shareUrl(link, `/tracks/${track.albumId}/${track.trackId}/stream`),
    );
    assert.ok(track != null);
    assert.equal(response.status, 404, `${track.title} is outside the link`);
  }
});

test("downloads stay closed unless the link allows them", async () => {
  const link = await createLink({ kind: "album", albumMbid: FIRST_ALBUM_MBID });
  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  assert.ok(opening != null);
  for (const suffix of ["/download", `/tracks/${opening.albumId}/${opening.trackId}/download`]) {
    assert.equal((await fetch(await shareUrl(link, suffix))).status, 404);
  }
});

test("a download gives the original file", async () => {
  const link = await createLink(
    { kind: "album", albumMbid: FIRST_ALBUM_MBID },
    { allowDownload: true },
  );
  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  assert.ok(opening != null);
  const response = await fetch(
    await shareUrl(link, `/tracks/${opening.albumId}/${opening.trackId}/download`),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-disposition")!,
    /attachment; filename="01 Opening Song.flac"/,
  );
  assert.ok(opening != null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), opening.bytes);
});

test("Download all for an artist zips every album's original files", async () => {
  const link = await createLink(
    { kind: "artist", artistMbid: ARTIST_MBID },
    { allowDownload: true },
  );
  const response = await fetch(await shareUrl(link, "/download"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /filename="Share Artist.zip"/);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), body.length);

  const entries = readZip(body);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      "Share Artist/First Album/01 Opening Song.flac",
      "Share Artist/First Album/02 Second Song.flac",
      "Share Artist/First Album/2-01 Disc Two Song.mp3",
      "Share Artist/Second Album/01 Later Song.flac",
    ],
  );
  const expected = [...firstAlbum.tracks, ...secondAlbum.tracks];
  for (const entry of entries) {
    const source = expected.find((track) => entry.name.endsWith(track.file));
    assert.ok(source != null);
    assert.deepEqual(entry.data, source.bytes, entry.name);
  }
});

test("expired, stopped, and disabled-owner links stop serving", async () => {
  const expiring = await createLink({ kind: "artist", artistMbid: ARTIST_MBID });
  const stopped = await createLink({ kind: "album", albumMbid: FIRST_ALBUM_MBID });
  const kept = await createLink({ kind: "album", albumMbid: SECOND_ALBUM_MBID });

  db.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expiring.id);
  assert.equal((await fetch(await shareUrl(expiring))).status, 404);

  assert.equal((await callApi("DELETE", `/${stopped.id}`, { user: stranger })).status, 404);
  assert.equal((await fetch(await shareUrl(stopped))).status, 200);
  assert.equal((await callApi("DELETE", `/${stopped.id}`)).status, 204);
  assert.equal((await fetch(await shareUrl(stopped))).status, 404);

  const listed = await callApi("GET", "");
  assert.deepEqual(
    listed.body.links.map((link: { id: string }) => link.id),
    [kept.id],
  );
  assert.deepEqual([...(await callApi("GET", "", { user: stranger })).body.links], []);

  userOps.updateUser(owner.id, { status: "disabled" });
  try {
    assert.equal((await fetch(await shareUrl(kept))).status, 404);
  } finally {
    userOps.updateUser(owner.id, { status: "active" });
  }
});

test("the tunnel runs while links are live and only reaches share links", async () => {
  const first = await createLink({ kind: "track", libraryTrackId: secondAlbum.tracks[0].trackId });
  const second = await createLink({ kind: "album", albumMbid: SECOND_ALBUM_MBID });
  const target = await tunnelTarget();
  const started = await launches();
  assert.equal(started.length, 1, "one tunnel serves every live link");
  const { pid, args } = started[0];
  assert.deepEqual(args.slice(args.indexOf("--metrics"), args.indexOf("--metrics") + 2), [
    "--metrics",
    "127.0.0.1:0",
  ]);
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/);

  const registered = await nextLookup((entry) => entry.method === "PUT");
  const instanceId = first.url.match(/~([A-Za-z0-9_-]+)\./)[1];
  assert.equal(registered.url, `/api/instances/${instanceId}`);
  assert.ok(registered.body != null);
  assert.equal(registered.body.url, "https://fake-tunnel-1.trycloudflare.com");
  assert.ok(registered.body != null);
  assert.ok(registered.body.secret.length >= 32);
  assert.deepEqual(await (await fetch(`${target}/share/.well-known/aurral`)).json(), {
    instanceId,
  });
  assert.equal((await callApi("GET", "")).body.tunnel, "online");

  for (const pathname of [
    "/api/health/live",
    "/api/settings",
    "/api/share-links",
    "/rest/ping",
    "/",
  ]) {
    assert.equal((await fetch(`${target}${pathname}`)).status, 404, pathname);
  }
  assert.equal((await fetch(await shareUrl(first), { method: "POST" })).status, 405);

  assert.equal((await callApi("DELETE", `/${first.id}`)).status, 204);
  assert.ok(isRunning(pid), "the tunnel stays up while another link is live");
  assert.equal((await callApi("DELETE", `/${second.id}`)).status, 204);
  assert.equal(isRunning(pid), false);
  const removed = await nextLookup((entry) => entry.method === "DELETE");
  assert.ok(removed.body != null);
  assert.ok(registered.body != null);
  assert.equal(removed.body.secret, registered.body.secret);
  await assert.rejects(fetch(`${target}/share/${tokenOf(first)}`));
  await writeFile(launchLog, "");
});

test("a crashed tunnel restarts and registers its new address", async () => {
  await createLink({ kind: "album", albumMbid: SECOND_ALBUM_MBID });
  await nextLookup((entry) => entry.method === "PUT");
  const [crashed] = await launches();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  process.kill(crashed.pid, "SIGKILL");
  await vi.waitFor(() => assert.equal(isRunning(crashed.pid), false), { timeout: 5000 });
  await vi.runOnlyPendingTimersAsync();

  const reregistered = await nextLookup(
    (entry) =>
      entry.method === "PUT" && entry.body?.url === "https://fake-tunnel-2.trycloudflare.com",
  );
  assert.ok(reregistered);
  assert.equal((await launches()).length, 2);
  db.prepare("DELETE FROM share_links").run();
  await listener.syncShareListener();
  await writeFile(launchLog, "");
});

test("Profile shows the tunnel as unreachable while aurral.org refuses it", async () => {
  lookupStatus = 503;
  await createLink({ kind: "album", albumMbid: SECOND_ALBUM_MBID });
  await nextLookup((entry) => entry.method === "PUT");
  await vi.waitFor(
    async () => assert.equal((await callApi("GET", "")).body.tunnel, "unreachable"),
    { timeout: 5000 },
  );
  db.prepare("DELETE FROM share_links").run();
  await listener.syncShareListener();
  await writeFile(launchLog, "");
});

test("an artist without a MusicBrainz ID shares from its Library ID", async () => {
  const link = await createLink({ kind: "artist", libraryArtistId: String(localArtist.id) });
  assert.equal(link.title, "Home Recorder");
  const response = await fetch(await shareUrl(link));
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).tracks.map((track: { title: string; path: string }) => track.title),
    ["Basement Take"],
  );
});

test("only Library items can be shared to listen", async () => {
  assert.deepEqual(
    (await callApi("GET", `/availability?kind=artist&artistMbid=${ARTIST_MBID}`)).body,
    {
      trackCount: 4,
      tunnelAvailable: true,
      totalTracks: null,
    },
  );
  const missingMbid = "79999999-9999-4999-8999-999999999999";
  assert.equal(
    (await callApi("GET", `/availability?kind=album&albumMbid=${missingMbid}`)).body.trackCount,
    0,
  );
  const created = await callApi("POST", "", {
    body: { kind: "album", albumMbid: missingMbid, payload: PAYLOAD, expiresIn: "7d" },
  });
  assert.equal(created.status, 404);
  assert.equal(
    requireFixture(
      db.prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM share_links").get(),
    ).count,
    0,
  );
  assert.deepEqual(await launches(), []);
});

test("details-only shares publish permanent links without starting a tunnel", async () => {
  const created = await callApi("POST", "", {
    body: {
      kind: "album",
      manifest: { kind: "album", title: "An unowned album", artistName: "Another artist" },
      shareFiles: false,
      expiresIn: "7d",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.link.shareFiles, false);
  assert.equal(created.body.link.expiresAt, null);
  assert.match(created.body.link.url, /\/s\/s[A-Za-z0-9_-]{15}$/);
  assert.equal(lookupRequests.length, 1);
  assert.match(lookupRequests[0].url || "", /^\/api\/shares\//);
  assert.deepEqual(await launches(), []);
  assert.equal(created.body.link.id, undefined);
  assert.equal((await callApi("GET", "")).body.links.length, 0);
});

test("stopping an album share ends file access but keeps its link, even when retried", async () => {
  const created = await callApi("POST", "", {
    body: {
      kind: "album",
      libraryAlbumId: String(firstAlbum.album.id),
      manifest: { kind: "album", title: firstAlbum.album.title, artistName: artist.name },
      shareFiles: true,
      allowDownload: true,
      expiresIn: "7d",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { getLiveShareLink, getShareLinkSchedule } =
    await import("../../backend/services/shareLinks/store.ts");
  const token = tokenOf(created.body.link);
  assert.ok(getLiveShareLink(token));
  lookupStatus = 503;
  assert.equal((await callApi("DELETE", `/${created.body.link.id}`)).status, 503);
  assert.equal(getLiveShareLink(token), null);
  assert.equal(getShareLinkSchedule().count, 0);
  const remaining = (await callApi("GET", "")).body.links;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].shareFiles, false);
  assert.equal(remaining[0].allowDownload, false);
  lookupStatus = 204;
  lookupRequests.length = 0;
  assert.equal((await callApi("DELETE", `/${created.body.link.id}`)).status, 204);
  assert.equal((await callApi("GET", "")).body.links.length, 0);
  const kept = lookupRequests.find((entry) => entry.url?.startsWith("/api/shares/"));
  assert.equal(kept?.method, "PUT");
  assert.ok(kept?.body && "manifest" in kept.body && "shareFiles" in kept.body);
  assert.equal(kept.body.shareFiles, false);
  const { parseShareManifest } = await import("../../lib/shareManifest.ts");
  const details = parseShareManifest(kept.body.manifest);
  assert.equal(details?.title, firstAlbum.album.title);
  assert.ok(details?.tracks.length);
  assert.ok(details.tracks.every((track) => track.path === null));
});

test("a release-only album never publishes its release ID as a release-group ID", async () => {
  const releaseMbid = "78888888-8888-4888-8888-888888888888";
  const album = media.upsertLibraryAlbum({
    identityKey: `album:${releaseMbid}`,
    artistId: artist.id,
    title: "Release only",
    mbid: releaseMbid,
  });
  const track = media.upsertLibraryTrack({
    identityKey: "track:release-only",
    title: "Release song",
    artistName: artist.name,
  });
  media.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  const file = await seedFile("release-only/song.flac", 4096);
  media.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: file.filePath,
    format: "flac",
  });
  const { resolveShareManifest } = await import("../../backend/services/shareLinks/metadata.ts");
  const snapshot = resolveShareManifest(
    { kind: "album", targetRef: String(album.id), albumRef: null },
    { kind: "album", title: album.title, artistName: artist.name, albumMbid: releaseMbid },
  );
  assert.ok(snapshot);
  assert.equal(snapshot.albumMbid, null);
  assert.equal(snapshot.tracks[0].albumMbid, null);
  assert.equal(snapshot.tracks[0].releaseMbid, releaseMbid);
});

test("shared recordings keep the requested album, metadata and file", async () => {
  const mbid = "79999999-9999-4999-8999-999999999999";
  const track = media.upsertLibraryTrack({
    identityKey: `recording:${mbid}`,
    mbid,
    title: "Repeat",
    artistName: artist.name,
  });
  for (const [album, number] of [
    [firstAlbum.album, 4],
    [secondAlbum.album, 7],
  ] as const) {
    media.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: number });
    const file = await seedFile(`${album.title}/repeat.flac`, 4096);
    media.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: file.filePath,
      format: "flac",
    });
  }
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const { resolveShareManifest } = await import("../../backend/services/shareLinks/metadata.ts");
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Album context",
    ownerUserId: owner.id,
    tracks: [
      {
        trackName: "Repeat",
        artistName: artist.name,
        trackMbid: mbid,
        albumMbid: SECOND_ALBUM_MBID,
        albumName: secondAlbum.album.title,
        trackNumber: 9,
      },
    ],
  });
  const snapshot = resolveShareManifest(
    { kind: "playlist", targetRef: playlist.id, albumRef: null },
    { kind: "playlist", title: playlist.name },
  );
  assert.ok(snapshot);
  assert.equal(snapshot.tracks[0].albumTitle, secondAlbum.album.title);
  assert.equal(snapshot.tracks[0].trackNumber, 9);
  assert.equal(snapshot.tracks[0].path, `tracks/${secondAlbum.album.id}/${track.id}`);
  const artistShare = resolveShareManifest(
    { kind: "artist", targetRef: String(artist.id), albumRef: null },
    { kind: "artist", title: artist.name, artistName: artist.name },
  );
  assert.ok(artistShare);
  assert.deepEqual(
    artistShare.tracks
      .filter((entry) => entry.trackMbid === mbid)
      .map((entry) => [entry.albumTitle, entry.trackNumber, entry.path]),
    [
      [firstAlbum.album.title, 4, `tracks/${firstAlbum.album.id}/${track.id}`],
      [secondAlbum.album.title, 7, `tracks/${secondAlbum.album.id}/${track.id}`],
    ],
  );
  for (const trackMbid of [null, mbid]) {
    const created = await callApi("POST", "", {
      body: {
        kind: "track",
        title: "Repeat",
        artistName: artist.name,
        trackMbid,
        albumTitle: secondAlbum.album.title,
        manifest: {
          kind: "track",
          title: "Repeat",
          artistName: artist.name,
          tracks: [
            { title: "Repeat", artistName: artist.name, albumTitle: secondAlbum.album.title },
          ],
        },
        shareFiles: true,
        expiresIn: "7d",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const row = db
      .prepare<[number], { manifest: string }>("SELECT manifest FROM share_links WHERE id = ?")
      .get(created.body.link.id);
    assert.ok(row);
    assert.equal(
      JSON.parse(row.manifest).tracks[0].path,
      `tracks/${secondAlbum.album.id}/${track.id}`,
    );
  }
});

test("local access without an account creates short metadata links without granting file access", async () => {
  const localUser = { ...owner, id: 0 };
  const created = await callApi("POST", "/plain", {
    user: localUser,
    body: {
      manifest: {
        kind: "track",
        title: "Opening Song",
        artistName: artist.name,
        tracks: [
          {
            title: "Opening Song",
            artistName: artist.name,
            path: "tracks/1/1",
            format: "flac",
            size: 100,
          },
        ],
      },
      shareFiles: true,
      allowDownload: true,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.link.url, /\/s\/s[A-Za-z0-9_-]{15}$/);
  assert.equal(created.body.link.shareFiles, false);
  assert.equal((await callApi("GET", "", { user: localUser })).status, 403);
  const published = lookupRequests[0].body;
  assert.ok(published && "manifest" in published && "shareFiles" in published);
  const { parseShareManifest } = await import("../../lib/shareManifest.ts");
  const snapshot = parseShareManifest(published.manifest);
  assert.ok(snapshot);
  assert.equal(snapshot.tracks[0].path, null);
  assert.equal(snapshot.tracks[0].size, null);
  assert.equal(published.shareFiles, false);
  assert.equal(
    (
      await callApi("POST", "/plain", {
        user: localUser,
        body: { manifest: { kind: "playlist", title: "Private playlist" } },
      })
    ).status,
    400,
  );
  assert.deepEqual(await launches(), []);
});

test("playlist shares play the library file an entry downloaded to", async () => {
  const albumMbid = "7a111111-1111-4111-8111-111111111111";
  const seeded = await seedAlbum({
    artist,
    mbid: albumMbid,
    title: "Mellon Collie",
    tracks: [
      { title: "1979", number: 1, file: "1979.flac" },
      { title: "Bullet", number: 2, file: "bullet.flac" },
    ],
  });
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const { resolveShareManifest } = await import("../../backend/services/shareLinks/metadata.ts");
  const remaster = {
    trackName: "1979 - Remastered 2012",
    artistName: artist.name,
    albumName: "Mellon Collie (Deluxe Edition)",
  };
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Remasters",
    ownerUserId: owner.id,
    tracks: [remaster, { trackName: "Bullet", artistName: artist.name }],
  });
  const jobId = downloadTracker.addJob(remaster, playlist.id);
  assert.ok(jobId);
  downloadTracker.setDone(
    jobId,
    path.join(paths.baseDir, "music", artist.name, "Mellon Collie", "1979.flac"),
  );
  const snapshot = resolveShareManifest(
    { kind: "playlist", targetRef: playlist.id, albumRef: null },
    { kind: "playlist", title: playlist.name },
  );
  assert.deepEqual(
    snapshot?.tracks.map((track) => [track.title, track.path]),
    seeded.tracks.map((track, index) => [
      playlist.tracks[index].trackName,
      `tracks/${track.albumId}/${track.trackId}`,
    ]),
  );
});

test("playlist shares keep missing entries and never expose tracks added after creation", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const playlistOwner = userOps.createUser("playlist-owner", "hash", "user", { accessFlow: true });
  assert.ok(playlistOwner);
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Shared playlist",
    ownerUserId: playlistOwner.id,
    tracks: [
      { trackName: "Opening Song", artistName: artist.name, albumName: firstAlbum.album.title },
      { trackName: "Not downloaded", artistName: artist.name },
    ],
  });
  const denied = await callApi("GET", `/availability?kind=playlist&playlistId=${playlist.id}`, {
    user: stranger,
  });
  assert.equal(denied.status, 404);
  const availability = await callApi(
    "GET",
    `/availability?kind=playlist&playlistId=${playlist.id}`,
    { user: playlistOwner },
  );
  assert.equal(availability.status, 200, JSON.stringify(availability.body));
  assert.equal(availability.body.trackCount, 1);
  assert.equal(availability.body.totalTracks, 2);
  const created = await callApi("POST", "", {
    user: playlistOwner,
    body: {
      kind: "playlist",
      playlistId: playlist.id,
      manifest: { kind: "playlist", title: playlist.name },
      shareFiles: true,
      allowDownload: true,
      expiresIn: "7d",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = db
    .prepare<[number], { manifest: string }>("SELECT manifest FROM share_links WHERE id = ?")
    .get(created.body.link.id);
  assert.ok(row);
  const { parseShareManifest } = await import("../../lib/shareManifest.ts");
  const snapshot = parseShareManifest(JSON.parse(row.manifest));
  assert.ok(snapshot);
  assert.deepEqual(
    snapshot.tracks.map((track) => track.title),
    ["Opening Song", "Not downloaded"],
  );
  assert.equal(snapshot.tracks[1].path, null);
  assert.ok(!row.manifest.includes(paths.baseDir));
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    tracks: [
      ...playlist.tracks,
      { trackName: "Later Song", artistName: artist.name, albumName: secondAlbum.album.title },
    ],
  });
  const base = await shareUrl(created.body.link);
  const publicFiles = await (await fetch(base)).json();
  assert.deepEqual(
    publicFiles.tracks.map((track: { title: string }) => track.title),
    ["Opening Song"],
  );
  assert.equal(
    (
      await fetch(
        `${base}/tracks/${secondAlbum.album.id}/${secondAlbum.tracks[0].trackId}/download`,
      )
    ).status,
    404,
  );
  db.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(
    Date.now() - 1,
    created.body.link.id,
  );
  await listener.syncShareListener();
  assert.ok(
    (await callApi("GET", "", { user: playlistOwner })).body.links.some(
      (link: { id: number }) => link.id === created.body.link.id,
    ),
  );
});

test("playlist shares republish changes daily without exposing files for added tracks", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const { refreshPlaylistShares } = await import("../../backend/services/shareLinks/refresh.ts");
  const curator = userOps.createUser("curator", "hash", "user", { accessFlow: true });
  assert.ok(curator);
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Synced playlist",
    ownerUserId: curator.id,
    tracks: [
      { trackName: "Opening Song", artistName: artist.name, albumName: firstAlbum.album.title },
    ],
  });
  const created = await callApi("POST", "", {
    user: curator,
    body: {
      kind: "playlist",
      playlistId: playlist.id,
      manifest: { kind: "playlist", title: playlist.name },
      shareFiles: true,
      allowDownload: true,
      expiresIn: "7d",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  lookupRequests.length = 0;

  await refreshPlaylistShares();
  assert.equal(lookupRequests.length, 0);

  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    name: "Renamed playlist",
    tracks: [
      ...playlist.tracks,
      { trackName: "Later Song", artistName: artist.name, albumName: secondAlbum.album.title },
    ],
  });
  await refreshPlaylistShares();
  const { parseShareManifest } = await import("../../lib/shareManifest.ts");
  const published = lookupRequests.find((entry) => entry.method === "PUT");
  assert.ok(published?.body);
  assert.ok("manifest" in published.body);
  const snapshot = parseShareManifest(published.body.manifest);
  assert.equal(snapshot?.title, "Renamed playlist");
  assert.deepEqual(
    snapshot?.tracks.map((track) => [track.title, Boolean(track.path)]),
    [
      ["Opening Song", true],
      ["Later Song", false],
    ],
  );
  const base = await shareUrl(created.body.link);
  assert.equal(
    (
      await fetch(
        `${base}/tracks/${secondAlbum.album.id}/${secondAlbum.tracks[0].trackId}/download`,
      )
    ).status,
    404,
  );

  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song")!;
  db.prepare("UPDATE library_media_files SET available = 0 WHERE track_id = ?").run(
    opening.trackId,
  );
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "Offline drive" });
  lookupRequests.length = 0;
  await refreshPlaylistShares();
  db.prepare("UPDATE library_media_files SET available = 1 WHERE track_id = ?").run(
    opening.trackId,
  );
  const offline = lookupRequests.find((entry) => entry.method === "PUT")?.body;
  assert.ok(offline && "manifest" in offline);
  assert.equal(
    parseShareManifest(offline.manifest)?.tracks[0].path,
    `tracks/${opening.albumId}/${opening.trackId}`,
  );

  lookupRequests.length = 0;
  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  await refreshPlaylistShares();
  assert.deepEqual(
    lookupRequests.map((entry) => entry.method),
    ["DELETE"],
  );
  assert.deepEqual((await callApi("GET", "", { user: curator })).body.links, []);
});
