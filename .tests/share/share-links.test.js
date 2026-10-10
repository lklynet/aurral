import assert from "node:assert/strict";
import test from "node:test";
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
} from "../helpers/backendTestHarness.js";

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

const lookupRequests = [];
const lookupWaiters = new Set();
let lookupStatus = 204;
const lookup = await createMockHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const entry = { method: request.method, url: request.url, body: body ? JSON.parse(body) : null };
    lookupRequests.push(entry);
    for (const waiter of lookupWaiters) waiter(entry);
    response.statusCode = lookupStatus;
    response.end();
  });
});
process.env.AURRAL_SHARE_ORIGIN = lookup.url;

function nextLookup(predicate) {
  const existing = lookupRequests.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const waiter = (entry) => {
      if (!predicate(entry)) return;
      lookupWaiters.delete(waiter);
      resolve(entry);
    };
    lookupWaiters.add(waiter);
  });
}

async function launches() {
  const text = await readFile(launchLog, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const [paths, { db }, { userOps }, listener, routes, media] = await setupIsolatedBackend(
  "share-links",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/shareLinks/shareListener.js",
  "backend/routes/shareLinks.js",
  "backend/services/libraryMediaStore.js",
);

const ARTIST_MBID = "71111111-1111-4111-8111-111111111111";
const FIRST_ALBUM_MBID = "72222222-2222-4222-8222-222222222222";
const SECOND_ALBUM_MBID = "73333333-3333-4333-8333-333333333333";
const OTHER_ARTIST_MBID = "74444444-4444-4444-8444-444444444444";
const PAYLOAD = "AQIDdGVzdA";

const owner = userOps.createUser("sharer", "hash");
const stranger = userOps.createUser("stranger", "hash");

async function seedFile(relativePath, size) {
  const filePath = path.join(paths.baseDir, "music", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = crypto.randomBytes(size);
  await writeFile(filePath, bytes);
  return { filePath, bytes };
}

async function seedAlbum({ artist, mbid, title, tracks }) {
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

const api = express();
api.use(express.json());
api.use((req, res, next) => {
  const userId = Number(req.get("x-test-user"));
  req.user = userOps.getUserById(userId) || undefined;
  next();
});
api.use("/api/share-links", routes.default);
const apiServer = await new Promise((resolve) => {
  const server = api.listen(0, "127.0.0.1", () => resolve(server));
});
const apiUrl = `http://127.0.0.1:${apiServer.address().port}/api/share-links`;

test.after(async () => {
  await listener.stopShareListener();
  await new Promise((resolve) => apiServer.close(resolve));
  await lookup.close();
  await cleanupIsolatedState(paths);
  await rm(fakeBin, { recursive: true, force: true });
});

test.beforeEach(async () => {
  db.prepare("DELETE FROM share_links").run();
  await listener.syncShareListener();
  await writeFile(launchLog, "");
  lookupRequests.length = 0;
  lookupStatus = 204;
});

async function callApi(method, url, { user = owner, body } = {}) {
  const response = await fetch(`${apiUrl}${url}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": String(user.id) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createLink(item, options = {}) {
  const response = await callApi("POST", "", {
    body: { ...item, payload: PAYLOAD, allowDownload: false, expiresIn: "7d", ...options },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.link;
}

const tokenOf = (link) => link.url.split(".").at(-1);

async function tunnelTarget() {
  await nextLookup((entry) => entry.method === "PUT");
  const latest = (await launches()).at(-1);
  assert.ok(latest && isRunning(latest.pid), "cloudflared should run while a link is live");
  return latest.args[latest.args.indexOf("--url") + 1];
}

async function shareUrl(link, suffix = "") {
  return `${await tunnelTarget()}/share/${tokenOf(link)}${suffix}`;
}

function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
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
    share.tracks.map((track) => track.title),
    ["Opening Song", "Second Song", "Disc Two Song"],
  );
  assert.equal(share.allowDownload, false);

  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  const ranged = await fetch(await shareUrl(link, `/tracks/${opening.albumId}/${opening.trackId}/stream`), {
    headers: { Range: "bytes=100-199" },
  });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), opening.bytes.subarray(100, 200));

  const flow = firstAlbum.tracks.find((track) => track.title === "Flow Song");
  const later = secondAlbum.tracks[0];
  for (const track of [flow, later]) {
    const response = await fetch(await shareUrl(link, `/tracks/${track.albumId}/${track.trackId}/stream`));
    assert.equal(response.status, 404, `${track.title} is outside the link`);
  }
});

test("downloads stay closed unless the link allows them", async () => {
  const link = await createLink({ kind: "album", albumMbid: FIRST_ALBUM_MBID });
  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  for (const suffix of ["/download", `/tracks/${opening.albumId}/${opening.trackId}/download`]) {
    assert.equal((await fetch(await shareUrl(link, suffix))).status, 404);
  }
});

test("a download gives the original file", async () => {
  const link = await createLink({ kind: "album", albumMbid: FIRST_ALBUM_MBID }, { allowDownload: true });
  const opening = firstAlbum.tracks.find((track) => track.title === "Opening Song");
  const response = await fetch(await shareUrl(link, `/tracks/${opening.albumId}/${opening.trackId}/download`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment; filename="01 Opening Song.flac"/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), opening.bytes);
});

test("Download all for an artist zips every album's original files", async () => {
  const link = await createLink({ kind: "artist", artistMbid: ARTIST_MBID }, { allowDownload: true });
  const response = await fetch(await shareUrl(link, "/download"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /filename="Share Artist.zip"/);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), body.length);

  const entries = readZip(body);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "Share Artist/First Album/01 Opening Song.flac",
    "Share Artist/First Album/02 Second Song.flac",
    "Share Artist/First Album/2-01 Disc Two Song.mp3",
    "Share Artist/Second Album/01 Later Song.flac",
  ]);
  const expected = [...firstAlbum.tracks, ...secondAlbum.tracks];
  for (const entry of entries) {
    const source = expected.find((track) => entry.name.endsWith(track.file));
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
  assert.deepEqual(listed.body.links.map((link) => link.id), [kept.id]);
  assert.deepEqual((await callApi("GET", "", { user: stranger })).body.links, []);

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
  assert.equal(registered.body.url, "https://fake-tunnel-1.trycloudflare.com");
  assert.ok(registered.body.secret.length >= 32);
  assert.deepEqual(await (await fetch(`${target}/share/.well-known/aurral`)).json(), { instanceId });
  assert.equal((await callApi("GET", "")).body.tunnel, "online");

  for (const pathname of ["/api/health/live", "/api/settings", "/api/share-links", "/rest/ping", "/"]) {
    assert.equal((await fetch(`${target}${pathname}`)).status, 404, pathname);
  }
  assert.equal((await fetch(await shareUrl(first), { method: "POST" })).status, 405);

  assert.equal((await callApi("DELETE", `/${first.id}`)).status, 204);
  assert.ok(isRunning(pid), "the tunnel stays up while another link is live");
  assert.equal((await callApi("DELETE", `/${second.id}`)).status, 204);
  assert.equal(isRunning(pid), false);
  const removed = await nextLookup((entry) => entry.method === "DELETE");
  assert.equal(removed.body.secret, registered.body.secret);
  await assert.rejects(fetch(`${target}/share/${tokenOf(first)}`));
  await writeFile(launchLog, "");
});

test("a crashed tunnel restarts and registers its new address", { timeout: 20000 }, async () => {
  await createLink({ kind: "album", albumMbid: SECOND_ALBUM_MBID });
  await nextLookup((entry) => entry.method === "PUT");
  const [crashed] = await launches();
  process.kill(crashed.pid, "SIGKILL");

  const reregistered = await nextLookup(
    (entry) => entry.method === "PUT" && entry.body.url === "https://fake-tunnel-2.trycloudflare.com",
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await callApi("GET", "")).body.tunnel, "unreachable");
  db.prepare("DELETE FROM share_links").run();
  await listener.syncShareListener();
  await writeFile(launchLog, "");
});

test("only Library items can be shared to listen", async () => {
  assert.deepEqual((await callApi("GET", `/availability?kind=artist&artistMbid=${ARTIST_MBID}`)).body, {
    trackCount: 4,
    tunnelAvailable: true,
  });
  const missingMbid = "79999999-9999-4999-8999-999999999999";
  assert.equal(
    (await callApi("GET", `/availability?kind=album&albumMbid=${missingMbid}`)).body.trackCount,
    0,
  );
  const created = await callApi("POST", "", {
    body: { kind: "album", albumMbid: missingMbid, payload: PAYLOAD, expiresIn: "7d" },
  });
  assert.equal(created.status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM share_links").get().count, 0);
  assert.deepEqual(await launches(), []);
});
