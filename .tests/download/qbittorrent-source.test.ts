import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test, type TestContext } from "vite-plus/test";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.ts";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";
import { createTrackedJob, trackedJob } from "./fixtures.ts";

const [
  state,
  { db },
  { dbOps },
  { qbittorrentSource, removeSeededTorrents },
  { qbittorrentClient },
  { DownloadSourceError },
  { processSourcePipelinePayload },
  { downloadTracker },
] = await setupIsolatedBackend(
  "qbittorrent-source",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/qbittorrentSource.ts"),
  () => import("../../backend/services/qbittorrentClient.ts"),
  () => import("../../backend/services/download/downloadSource.ts"),
  () => import("../../backend/services/download/sourcePipeline.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
);

type Payload = Parameters<typeof processSourcePipelinePayload>[0];
type Torrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  tags: string;
  save_path: string;
  files: { name: string; size: number; priority: number }[];
};

const MAGNET = "magnet:?xt=urn:btih:abc";
const ALBUM = {
  artist: "Glass Coast",
  title: "Lowlands",
  releaseMbid: null,
  releaseGroupMbid: null,
  tracks: [],
};

let fake: Awaited<ReturnType<typeof startFake>>;
let folder = "";

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFake() {
  const fake = {
    sid: "first",
    logins: 0,
    torrents: [] as Torrent[],
    releases: [] as Record<string, unknown>[],
    musicReleases: null as Record<string, unknown>[] | null,
    added: [] as FormData[],
    deleted: [] as string[],
    onAdd: (_tag: string) => {},
  };
  const byHash = (hash: string | null) => fake.torrents.find((torrent) => torrent.hash === hash);
  const server = await createMockHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const payload = await buffer(request);
    if (url.pathname === "/api/v2/auth/login") {
      fake.logins += 1;
      const form = new URLSearchParams(payload.toString());
      if (form.get("password") !== "secret") {
        response.writeHead(401);
        return response.end();
      }
      response.writeHead(204, { "Set-Cookie": `QBT_SID_8080=${fake.sid}; HttpOnly; path=/` });
      return response.end();
    }
    if (url.pathname.startsWith("/api/v2/")) {
      if (request.headers.cookie !== `QBT_SID_8080=${fake.sid}`) {
        response.writeHead(403);
        return response.end("Forbidden");
      }
      if (url.pathname === "/api/v2/torrents/info") return json(response, fake.torrents);
      if (url.pathname === "/api/v2/app/version") return response.end("v5.0.0");
      if (url.pathname === "/api/v2/torrents/files") {
        const torrent = byHash(url.searchParams.get("hash"));
        if (!torrent) {
          response.writeHead(404);
          return response.end();
        }
        return json(response, torrent.files);
      }
      if (url.pathname === "/api/v2/torrents/filePrio") {
        const form = new URLSearchParams(payload.toString());
        const torrent = byHash(form.get("hash"));
        for (const id of String(form.get("id")).split("|")) {
          const file = torrent?.files[Number(id)];
          if (file) file.priority = Number(form.get("priority"));
        }
        return response.end();
      }
      if (url.pathname === "/api/v2/torrents/start") {
        const torrent = byHash(new URLSearchParams(payload.toString()).get("hashes"));
        if (torrent) Object.assign(torrent, { state: "stalledUP", progress: 1 });
        return response.end();
      }
      if (url.pathname === "/api/v2/torrents/add") {
        const form = await new Request("http://fake", {
          method: "POST",
          headers: { "content-type": String(request.headers["content-type"]) },
          body: payload,
        }).formData();
        if (
          fake.added.some((added) => added.get("urls") === form.get("urls") && form.get("urls"))
        ) {
          response.writeHead(409);
          return response.end("Fails.");
        }
        fake.added.push(form);
        fake.onAdd(String(form.get("tags")));
        return response.end("Ok.");
      }
      if (url.pathname === "/api/v2/torrents/addTags") {
        const form = new URLSearchParams(payload.toString());
        const torrent = byHash(form.get("hashes"));
        if (torrent) torrent.tags = [torrent.tags, form.get("tags")].filter(Boolean).join(", ");
        return response.end();
      }
      if (url.pathname === "/api/v2/torrents/delete") {
        fake.deleted.push(String(new URLSearchParams(payload.toString()).get("hashes")));
        return response.end();
      }
    }
    if (url.pathname === "/release.torrent") return response.end("d4:infod4:name8:Lowlandsee");
    if (url.pathname === "/magnet-only") {
      response.writeHead(302, { Location: MAGNET });
      return response.end();
    }
    if (url.pathname === "/api/v1/indexer")
      return json(response, [
        {
          id: 3,
          name: "Torrents",
          enable: true,
          protocol: "torrent",
          supportsSearch: true,
          capabilities: {
            categories: [{ id: 3000 }],
            musicSearchParams: ["q", "artist", "album"],
          },
        },
      ]);
    if (url.pathname === "/api/v1/search")
      return json(
        response,
        url.searchParams.get("type") === "music"
          ? (fake.musicReleases ?? fake.releases)
          : fake.releases,
      );
    response.writeHead(404);
    response.end();
  });
  return Object.assign(fake, { url: server.url, close: server.close });
}

function release(
  guid: string,
  title: string,
  seeders: number,
  link = "/release.torrent",
  field = "downloadUrl",
) {
  return {
    guid,
    title,
    seeders,
    size: 300_000_000,
    protocol: "torrent",
    indexerId: 3,
    [field]: `${fake.url}${link}`,
    categories: [{ id: 3000 }],
  };
}

beforeEach(async () => {
  resetDatabase(db);
  fake = await startFake();
  folder = await mkdtemp(path.join(tmpdir(), "aurral-qbittorrent-"));
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      prowlarr: { enabled: true, url: fake.url, apiKey: "prowlarr-key" },
      qbittorrent: { enabled: true, url: fake.url, username: "aurral", password: "secret" },
    },
    pathMappings: [{ source: "qbittorrent", remote: "/downloads", local: folder }],
  });
  qbittorrentClient.updateConfig();
});

afterEach(async () => {
  await fake.close();
  await rm(folder, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("an album search keeps seeded torrents of the album, best quality first", async () => {
  fake.releases = [
    release("mp3", "Glass Coast - Lowlands (2020) [MP3 320]", 40),
    release("flac", "Glass Coast - Lowlands (2020) [FLAC]", 5),
    release("dead", "Glass Coast - Lowlands (2020) [FLAC 24bit]", 0),
    release("other", "Glass Coast - Highlands (2022) [FLAC]", 90),
  ];

  const results = await qbittorrentSource.albums!.search(ALBUM, null);
  const upgrades = await qbittorrentSource.albums!.search(ALBUM, { currentTier: "mp3-320" });

  assert.deepEqual(
    results.map((result) => [result.id, result.title]),
    [
      ["flac", "Lowlands"],
      ["mp3", "Lowlands"],
    ],
  );
  assert.deepEqual(
    upgrades.map((result) => result.id),
    ["flac"],
  );

  fake.musicReleases = [release("mp3", "Glass Coast - Lowlands (2020) [MP3 320]", 40)];
  const broader = await qbittorrentSource.albums!.search(ALBUM, { currentTier: "mp3-320" });
  assert.deepEqual(
    broader.map((result) => result.id),
    ["flac"],
  );
});

test("a download hands qBittorrent the torrent file, or the magnet Prowlarr's link redirects to, and moves on when qBittorrent already has it", async () => {
  fake.releases = [
    release("file", "Glass Coast - Lowlands [FLAC]", 5),
    release("magnet", "Glass Coast - Lowlands [MP3]", 5, "/magnet-only", "magnetUrl"),
  ];
  const [file, magnet] = await qbittorrentSource.albums!.search(ALBUM, null);
  assert.ok(file && magnet);
  const directory = path.join(folder, "staging");

  const first = await qbittorrentSource.albums!.download({ result: file, album: ALBUM, directory });
  const second = await qbittorrentSource.albums!.download({
    result: magnet,
    album: ALBUM,
    directory,
  });

  const [fileForm, magnetForm] = fake.added;
  assert.ok(fileForm && magnetForm);
  const torrent = fileForm.get("torrents");
  assert.ok(torrent instanceof Blob);
  assert.equal(await torrent.text(), "d4:infod4:name8:Lowlandsee");
  assert.equal(fileForm.get("category"), "aurral");
  assert.equal(fileForm.get("tags"), first?.pending);
  assert.equal(magnetForm.get("urls"), MAGNET);
  assert.equal(magnetForm.get("tags"), second?.pending);
  assert.equal(magnetForm.get("stopCondition"), "MetadataReceived");
  assert.notEqual(first?.pending, second?.pending);
  await assert.rejects(
    qbittorrentSource.albums!.download({ result: magnet, album: ALBUM, directory }),
    (error) => error instanceof DownloadSourceError && /didn't add/.test(error.message),
  );
});

test("status waits for the torrent, signs in again when its session ends, then links the kept audio files into the download folder, and a connection test always checks the password", async () => {
  await mkdir(path.join(folder, "Lowlands", "CD2"), { recursive: true });
  await writeFile(path.join(folder, "Lowlands", "01 Night Drive.flac"), "audio");
  await writeFile(path.join(folder, "Lowlands", "CD2", "01 Tide.flac"), "audio");
  const directory = path.join(folder, "staging");
  await mkdir(directory);
  const torrent = {
    hash: "h1",
    name: "Lowlands",
    state: "downloading",
    progress: 0.5,
    tags: "aurral-1",
    save_path: "/downloads",
    files: [
      { name: "Lowlands/01 Night Drive.flac", size: 5, priority: 1 },
      { name: "Lowlands/CD2/01 Tide.flac", size: 5, priority: 1 },
      { name: "Lowlands/02 Skipped.flac", size: 5, priority: 0 },
      { name: "Lowlands/cover.jpg", size: 5, priority: 1 },
    ],
  };
  fake.torrents = [{ ...torrent, hash: "untagged", tags: "" }, torrent];

  assert.deepEqual(await qbittorrentSource.status({ id: "aurral-1", directory }), { done: false });
  fake.sid = "second";
  Object.assign(torrent, { state: "stalledUP", progress: 1 });
  assert.deepEqual(await qbittorrentSource.status({ id: "aurral-1", directory }), { done: true });
  assert.equal(torrent.tags, "aurral-1, aurral-imported");

  assert.equal(fake.logins, 2);
  assert.deepEqual((await readdir(directory, { recursive: true })).sort(), [
    "Lowlands",
    path.join("Lowlands", "01 Night Drive.flac"),
    path.join("Lowlands", "CD2"),
    path.join("Lowlands", "CD2", "01 Tide.flac"),
  ]);
  torrent.state = "error";
  await assert.rejects(
    qbittorrentSource.status({ id: "aurral-1", directory }),
    (error) => error instanceof DownloadSourceError && /error/.test(error.message),
  );

  assert.equal((await qbittorrentClient.testConnection()).connected, true);
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      qbittorrent: { ...settings.integrations.qbittorrent, password: "wrong" },
    },
  });
  assert.equal((await qbittorrentClient.testConnection()).connected, false);
});

test("discard removes the torrent, finished or not", async () => {
  const torrent = { name: "", state: "downloading", save_path: "", files: [] };
  fake.torrents = [
    { ...torrent, hash: "other", progress: 0.1, tags: "" },
    { ...torrent, hash: "partial", progress: 0.4, tags: "a" },
    { ...torrent, hash: "done", state: "uploading", progress: 1, tags: "b" },
  ];

  await qbittorrentSource.discard!("a");
  await qbittorrentSource.discard!("b");

  assert.deepEqual(fake.deleted, ["partial", "done"]);
});

test("cleanup removes imported torrents once qBittorrent stops seeding them", async () => {
  const torrent = { name: "", save_path: "", files: [], progress: 1 };
  fake.torrents = [
    { ...torrent, hash: "stopped", state: "stoppedUP", tags: "aurral-1, aurral-imported" },
    { ...torrent, hash: "paused", state: "pausedUP", tags: "aurral-2, aurral-imported" },
    { ...torrent, hash: "seeding", state: "uploading", tags: "aurral-3, aurral-imported" },
    { ...torrent, hash: "unimported", state: "stoppedUP", tags: "aurral-4" },
    { ...torrent, hash: "other", state: "stoppedUP", tags: "" },
  ];

  await removeSeededTorrents();

  assert.deepEqual(fake.deleted, ["stopped|paused"]);
});

// An album torrent of Lowlands whose files are on disk, as qBittorrent
// would save them, and that qBittorrent adds when Aurral sends it.
async function lowlandsTorrent(name = (title: string, place: number) => `0${place} ${title}`) {
  const album = path.join(folder, "Glass Coast - Lowlands");
  await mkdir(album);
  const titles = ["Tide", "Night Drive"];
  for (const [index, title] of titles.entries())
    await writeFlacFixture(
      path.join(album, `${name(title, index + 1)}.flac`),
      { title, artist: "Glass Coast", album: "Lowlands", track: index + 1 },
      { seconds: 1 },
    );
  fake.releases = [release("lowlands", "Glass Coast - Lowlands (2020) [FLAC]", 5)];
  fake.onAdd = (tags) =>
    fake.torrents.push({
      hash: "h1",
      name: "Glass Coast - Lowlands",
      state: "downloading",
      progress: 0,
      tags,
      save_path: "/downloads",
      files: titles.map((title, index) => ({
        name: `Glass Coast - Lowlands/${name(title, index + 1)}.flac`,
        size: 30_000_000,
        priority: 1,
      })),
    });
}

async function runPipeline(start: Payload, last?: string) {
  const fail = async (_payload: Payload, _job: unknown, message: string) => {
    throw new Error(message);
  };
  let payload: Payload | null = start;
  const phases: string[] = [];
  while (payload && payload.phase !== "done") {
    phases.push(payload.phase);
    const next: unknown = await processSourcePipelinePayload(payload, qbittorrentSource, {
      failOrTryNextSource: fail,
    });
    payload = next && typeof next === "object" && "phase" in next ? (next as Payload) : null;
    if (phases.at(-1) === last) break;
  }
  return phases;
}

test("a track request downloads only the track's file from an album torrent and files it", async () => {
  await lowlandsTorrent();
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: "Night Drive",
      albumName: "Lowlands",
      durationMs: 1000,
    },
    "qbittorrent-source",
  );

  assert.deepEqual(await runPipeline({ jobId, phase: "search", source: "qbittorrent" }), [
    "search",
    "download",
    "poll",
    "finalize",
  ]);
  assert.deepEqual(
    fake.torrents[0]?.files.map((file) => file.priority),
    [0, 1],
  );
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  assert.equal(job.releaseGuid, "album:lowlands");
  assert.deepEqual(fake.deleted, []);
});

test("a track request downloads the whole album when the file names don't show the track, and picks it by its tags", async () => {
  await lowlandsTorrent((_title, place) => `Track ${place}`);
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: "Night Drive",
      albumName: "Lowlands",
      durationMs: 1000,
    },
    "qbittorrent-source",
  );

  await runPipeline({ jobId, phase: "search", source: "qbittorrent" });
  assert.deepEqual(
    fake.torrents[0]?.files.map((file) => file.priority),
    [1, 1],
  );
  assert.equal(trackedJob(downloadTracker, jobId).status, "done");
});

// A request for the second track of Lowlands, whose release has these tracks.
async function lowlandsAlbumJob(t: TestContext, titles: string[]) {
  await serveGroups(t, [
    brainzmashGroup({
      id: "lowlands-group",
      title: "Lowlands",
      artist: "Glass Coast",
      releases: [
        {
          id: "lowlands-release",
          tracks: titles.map((title) => ({ title, durationMs: 1000 })),
        },
      ],
    }),
  ]);
  return createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: titles[1] ?? "",
      albumName: "Lowlands",
      albumMbid: "lowlands-group",
      releaseMbid: "lowlands-release",
      trackNumber: 2,
      durationMs: 1000,
    },
    "qbittorrent-source",
  );
}

test("an album attempt downloads only its tracks once the torrent's files show the release", async (t) => {
  await lowlandsTorrent();
  const jobId = await lowlandsAlbumJob(t, ["Tide", "Night Drive"]);

  await runPipeline({
    jobId,
    phase: "search",
    source: "qbittorrent",
    albumGrab: true,
    albumGroupJobIds: [jobId],
    releaseMbid: "lowlands-release",
  });
  assert.deepEqual(
    fake.torrents[0]?.files.map((file) => file.priority),
    [0, 1],
  );
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  await access(String(job.finalPath));
  assert.deepEqual(fake.deleted, []);
});

test("an album upgrade keeps seeding the torrent it imported from", async (t) => {
  await lowlandsTorrent();
  const originalId = await lowlandsAlbumJob(t, ["Tide", "Night Drive"]);
  downloadTracker.setDone(originalId, path.join(folder, "old.mp3"), "Lowlands");
  downloadTracker.updateQuality(originalId, { tier: "mp3-128" });
  const jobId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, originalId));
  assert.ok(jobId);

  await runPipeline({
    jobId,
    phase: "search",
    source: "qbittorrent",
    albumGrab: true,
    albumGroupJobIds: [jobId],
    releaseMbid: "lowlands-release",
    upgrade: true,
    upgradeForJobId: originalId,
  });
  assert.equal(downloadTracker.getJob(jobId), null);
  assert.equal(trackedJob(downloadTracker, originalId).qualityTier, "flac-standard");
  assert.deepEqual(fake.deleted, []);
});

test("an album attempt removes a finished torrent it imported nothing from", async (t) => {
  await lowlandsTorrent();
  const jobId = await lowlandsAlbumJob(t, ["Harbor", "Pier"]);

  await runPipeline(
    {
      jobId,
      phase: "search",
      source: "qbittorrent",
      albumGrab: true,
      albumGroupJobIds: [jobId],
      releaseMbid: "lowlands-release",
    },
    "finalize",
  );
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "done");
  assert.deepEqual(fake.deleted, ["h1"]);
});
