import { test, beforeEach, afterAll, afterEach } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
const [
  state,
  { db },
  { dbOps, userOps },
  { playbackTaskQueue },
  { playlistManager },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { downloadTracker },
  { playlistDisplayNames },
  plex,
] = await setupIsolatedBackend(
  "playlist-files",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistFiles.ts"),
  () => import("../../backend/services/plex.ts"),
);
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";

const originalFetch = globalThis.fetch;

const { downloadRoot, libraryRoot } = playlistManager;

beforeEach(async () => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
  downloadTracker.clearAll();
  dbOps.updateSettings({ onboardingComplete: true, flows: [], staticPlaylists: [] });
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

async function addDownloadedTrack(playlistId: string, title: string) {
  const file = path.join(downloadRoot, "Artist", "Album", `${title}.flac`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, title);
  const track = { artistName: "Artist", trackName: title, albumName: "Album", durationMs: 61_400 };
  const jobId = downloadTracker.addJob(track, "library");
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, file, "Album");
  assert.ok(
    flowPlaylistConfig.appendStaticPlaylistTracks(playlistId, [
      { ...track, canonicalJobId: jobId },
    ]),
  );
}

const playlistFiles = async () =>
  (await fs.readdir(libraryRoot).catch(() => [])).filter((file) => file.endsWith(".m3u")).sort();

function pendingSyncs() {
  const now = Date.now();
  return playbackTaskQueue.list().flatMap(({ kind, run_at: runAt, payload }) =>
    kind === "playback-playlist-sync" && payload
      ? [
          {
            delaySeconds: Math.round((runAt - now) / 1000),
            entityIds: payload.entityIds,
            rewrite: payload.rewrite,
          },
        ]
      : [],
  );
}

test("writes a playlist file with full paths and rewrites it once later", async () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Road: Trip" });
  await addDownloadedTrack(playlist.id, "Song A");

  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });

  assert.deepEqual(await playlistFiles(), ["Road_ Trip.m3u"]);
  assert.equal(
    await fs.readFile(path.join(libraryRoot, "Road_ Trip.m3u"), "utf8"),
    `#EXTM3U\n#EXTINF:61,Artist - Song A\n${path.join(downloadRoot, "Artist", "Album", "Song A.flac")}\n`,
  );
  const [rewrite] = pendingSyncs();
  assert.ok(rewrite);
  assert.deepEqual([rewrite.entityIds, rewrite.rewrite], [[playlist.id], true]);
  assert.ok(rewrite.delaySeconds >= 170);

  db.prepare("DELETE FROM jobs").run();
  await playlistManager.syncPlaylists({ entityIds: [playlist.id], rewrite: true });
  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });
  assert.deepEqual(pendingSyncs(), []);
});

test("a later change pushes the pending rewrite out again", async () => {
  const first = flowPlaylistConfig.createStaticPlaylist({ name: "First" });
  const second = flowPlaylistConfig.createStaticPlaylist({ name: "Second" });
  await addDownloadedTrack(first.id, "Song A");
  await playlistManager.syncPlaylists({ entityIds: [first.id] });
  db.prepare("UPDATE jobs SET run_at = ?").run(Date.now() + 5000);

  await addDownloadedTrack(second.id, "Song B");
  await playlistManager.syncPlaylists({ entityIds: [second.id] });

  const [rewrite, ...rest] = pendingSyncs();
  assert.ok(rewrite);
  assert.deepEqual(rest, []);
  assert.deepEqual(rewrite.entityIds, [first.id, second.id]);
  assert.ok(rewrite.delaySeconds >= 170);
});

test("more tracks joining a pending sync keep its deadline", () => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Busy" });
  playlistManager.requestPlaylistSync([playlist.id]);
  const deadline = Date.now() + 500;
  db.prepare("UPDATE jobs SET run_at = ?").run(deadline);
  playlistManager.requestPlaylistSync([playlist.id]);
  const [merged, ...rest] = playbackTaskQueue.list();
  assert.deepEqual(rest, []);
  assert.equal(merged?.run_at, deadline);
});

test("renaming, disabling, or deleting removes the old file", async () => {
  const flow = flowPlaylistConfig.createFlow({ name: "Morning", size: 10 });
  flowPlaylistConfig.setEnabled(flow.id, true);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Keep" });
  await playlistManager.syncPlaylists();
  assert.deepEqual(await playlistFiles(), ["Keep.m3u", "Morning.m3u"]);

  flowPlaylistConfig.updateFlow(flow.id, { name: "Evening" });
  await playlistManager.syncPlaylists({ entityIds: [flow.id] });
  assert.deepEqual(await playlistFiles(), ["Evening.m3u", "Keep.m3u"]);

  flowPlaylistConfig.setEnabled(flow.id, false);
  await playlistManager.syncPlaylists({ entityIds: [flow.id] });
  assert.deepEqual(await playlistFiles(), ["Keep.m3u"]);

  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
  await playlistManager.syncPlaylists();
  assert.deepEqual(await playlistFiles(), []);
});

test("a rename that takes another playlist's file name moves that playlist's file too", async () => {
  dbOps.setJSONSetting("playlistFiles", { prefixOwnerUsername: false });
  const renamed = flowPlaylistConfig.createStaticPlaylist({ name: "Old" });
  const other = flowPlaylistConfig.createStaticPlaylist({ name: "Mix?" });
  await addDownloadedTrack(other.id, "Song B");
  await playlistManager.syncPlaylists();

  flowPlaylistConfig.updateStaticPlaylist(renamed.id, { name: "Mix:" });
  await playlistManager.syncPlaylists({ entityIds: [renamed.id] });

  assert.deepEqual(await playlistFiles(), ["Mix_ (2).m3u", "Mix_.m3u"]);
  assert.match(await fs.readFile(path.join(libraryRoot, "Mix_ (2).m3u"), "utf8"), /Song B/);
  assert.doesNotMatch(await fs.readFile(path.join(libraryRoot, "Mix_.m3u"), "utf8"), /Song B/);
});

test("names stay unique when the owner prefix is off", () => {
  const ana = userOps.createUser("ana", "hash")!.id;
  const bo = userOps.createUser("bo", "hash")!.id;
  const entities = [
    { id: "1", name: "Mix", ownerUserId: ana },
    { id: "2", name: "mix", ownerUserId: bo },
    { id: "3", name: "Solo", ownerUserId: ana },
    { id: "4", name: "Solo", ownerUserId: ana },
    { id: "5", name: "Solo (2)", ownerUserId: ana },
  ];

  assert.deepEqual(
    [...playlistDisplayNames(entities, { prefixOwnerUsername: false }).values()],
    ["ana - Mix", "bo - mix", "Solo", "Solo (2)", "Solo (2) (2)"],
  );
  assert.deepEqual(
    [...playlistDisplayNames(entities, { prefixOwnerUsername: true }).values()],
    ["ana - Mix", "bo - mix", "ana - Solo", "ana - Solo (2)", "ana - Solo (2) (2)"],
  );
});

const defaultSections = () => [
  { key: "2", type: "movie", Location: [{ path: downloadRoot }] },
  { key: "3", type: "artist", Location: [{ path: path.dirname(downloadRoot) }] },
];

function fakePlex({ uploadStatus = 200, sections = defaultSections() } = {}) {
  const requests: string[] = [];
  const playlists = new Map<string, string>();
  const fail = { deletes: false };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.href === "https://plex.tv/api/v2/user") return Response.json({ id: 5, username: "b" });
    if (url.pathname === "/accounts") return Response.json({ MediaContainer: { Account: [] } });
    if (url.pathname === "/library/sections")
      return Response.json({ MediaContainer: { Directory: sections } });
    if (url.pathname === "/playlists/upload") {
      const file = url.searchParams.get("path") ?? "";
      requests.push(`upload ${url.searchParams.get("sectionID")} ${path.basename(file)}`);
      if (uploadStatus === 200)
        playlists.set(path.basename(file, ".m3u"), String(playlists.size + 1));
      return new Response(null, { status: uploadStatus });
    }
    if (url.pathname === "/playlists" && method === "GET")
      return Response.json({
        MediaContainer: {
          Metadata: [...playlists].map(([title, ratingKey]) => ({ title, ratingKey })),
        },
      });
    if (method === "DELETE") {
      if (fail.deletes) return new Response(null, { status: 503 });
      const key = url.pathname.split("/").pop();
      const title = [...playlists].find(([, ratingKey]) => ratingKey === key)?.[0];
      requests.push(`delete ${title}`);
      if (title) playlists.delete(title);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
  return { requests, playlists, fail };
}

test("Plex gets each changed playlist file and loses renamed or emptied ones", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "token", sendPlaylists: true });
  const fake = fakePlex();
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Old" });
  flowPlaylistConfig.createStaticPlaylist({ name: "Empty" });
  await addDownloadedTrack(playlist.id, "Song A");

  await playlistManager.syncPlaylists();
  await playlistManager.syncPlaylists();
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "New" });
  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });

  assert.deepEqual(fake.requests, ["upload 3 Old.m3u", "delete Old", "upload 3 New.m3u"]);
  assert.deepEqual([...fake.playlists.keys()], ["New"]);
  assert.equal(plex.plexPlaylistStatus().error, null);
});

test("Plex playlists go to the music library closest to the Library folder", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "token", sendPlaylists: true });
  const library = (key: string, title: string, folder: string) => ({
    key,
    title,
    type: "artist",
    Location: [{ path: "/elsewhere" }, { path: folder }],
  });
  const fake = fakePlex({
    sections: [
      library("3", "Everything", path.dirname(downloadRoot)),
      library("4", "Music", `${downloadRoot}/`),
    ],
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Mix" });
  await addDownloadedTrack(playlist.id, "Song A");

  await playlistManager.syncPlaylists();
  assert.deepEqual(fake.requests, ["upload 4 Mix.m3u"]);
  assert.equal(plex.plexPlaylistStatus().note, null);

  fakePlex({
    sections: [
      library("3", "Everything", path.dirname(downloadRoot)),
      library("4", "Music", `${downloadRoot}/`),
      library("5", "Music 2", downloadRoot),
    ],
  });
  await playlistManager.syncPlaylists({ rewrite: true });
  assert.equal(
    plex.plexPlaylistStatus().note,
    `Plex libraries "Music" and "Music 2" share ${downloadRoot}. Playlists go to "Music".`,
  );
});

test("a playlist Plex can't match shows an error until an upload works", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "token", sendPlaylists: true });
  fakePlex({ uploadStatus: 500 });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Mix" });
  await addDownloadedTrack(playlist.id, "Song A");

  await playlistManager.syncPlaylists();
  assert.match(plex.plexPlaylistStatus().error ?? "", /Plex found none of the tracks in Mix/);

  fakePlex();
  await playlistManager.syncPlaylists({ rewrite: true });
  assert.equal(plex.plexPlaylistStatus().error, null);
});

test("a rename Plex couldn't apply removes the old playlist on the next sync", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "token", sendPlaylists: true });
  const fake = fakePlex();
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Old" });
  await addDownloadedTrack(playlist.id, "Song A");
  await playlistManager.syncPlaylists();

  fake.fail.deletes = true;
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "New" });
  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });
  assert.deepEqual([...fake.playlists.keys()], ["Old"]);

  fake.fail.deletes = false;
  await playlistManager.syncPlaylists({ entityIds: [playlist.id], rewrite: true });
  assert.deepEqual([...fake.playlists.keys()], ["New"]);
});

test("removals left from one Plex server never reach the next one", async () => {
  plex.savePlexServer({ url: "http://plex.test", token: "token", sendPlaylists: true });
  const fake = fakePlex();
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Old" });
  await addDownloadedTrack(playlist.id, "Song A");
  await playlistManager.syncPlaylists();
  fake.fail.deletes = true;
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { name: "New" });
  await playlistManager.syncPlaylists({ entityIds: [playlist.id] });

  fake.fail.deletes = false;
  await plex.connectPlexServer("http://plex.test", "other-token");
  fake.requests.length = 0;
  await playlistManager.syncPlaylists({ entityIds: [playlist.id], rewrite: true });

  assert.deepEqual(fake.requests, ["upload 3 New.m3u"]);
});
