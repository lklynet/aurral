import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";

vi.mock("../../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } = await importOriginal();
  return { default: (_minTime, options) => createRateLimiter(0, options) };
});
vi.mock("../../backend/services/metadataProviderBudget.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  reserveMetadataProviderRequest: () => 0,
}));

const [
  isolatedState,
  { db },
  { dbOps },
  { registerFiles },
  { registerTracks },
  { scanConfiguredLibrary },
  { resolveDownloadRoot },
  { reuseTrackForPlaylist },
  { downloadTracker },
  { downloadWorker },
  { processSystemTask },
  { clearScheduledLibraryScan },
] = await setupIsolatedBackend(
  "read-only-folders",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/routes/library/handlers/files.ts",
  "backend/routes/library/handlers/tracks.ts",
  "backend/services/libraryIndexService.ts",
  "backend/services/downloadPaths.ts",
  "backend/services/downloadJobs/fileReuse.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/downloadJobs/downloadWorker.ts",
  "backend/services/systemTaskWorker.ts",
  "backend/services/libraryScanWorker.ts",
);

const lidarrOn = { isConfigured: () => true };
const lidarrOff = { isConfigured: () => false };
const temporaryFolders = [];

beforeEach(async () => {
  resetDatabase(db);
  for (const table of [
    "library_media_files",
    "library_album_tracks",
    "library_tracks",
    "library_albums",
    "library_artists",
    "library_management",
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  dbOps.setJSONSetting("readOnlyFolders", []);
  clearScheduledLibraryScan();
  await mkdir(resolveDownloadRoot(), { recursive: true });
});

afterAll(async () => {
  await Promise.all(temporaryFolders.map((folder) => rm(folder, { recursive: true, force: true })));
  db.close();
  await cleanupIsolatedState(isolatedState);
});

async function makeFolder(name) {
  const folder = await mkdtemp(path.join(tmpdir(), `aurral-read-only-${name}-`));
  temporaryFolders.push(folder);
  return folder;
}

async function makeTrack(root, artist, album, title, trackNumber = 1) {
  const filePath = path.join(root, artist, album, `0${trackNumber} ${title}.flac`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFlacFixture(filePath, {
    artist,
    album_artist: artist,
    album,
    title,
    track: trackNumber,
  });
  return filePath;
}

function captureRoutes(register) {
  const routes = {};
  const capture =
    (method) =>
    (routePath, ...handlers) => {
      routes[`${method} ${routePath}`] = handlers.at(-1);
    };
  register({
    get: capture("GET"),
    post: capture("POST"),
    put: capture("PUT"),
    patch: capture("PATCH"),
    delete: capture("DELETE"),
  });
  return async (method, routePath, { body, params } = {}) => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    await routes[`${method} ${routePath}`]({ body, params, user: { id: 1 } }, response);
    return response;
  };
}

const callFiles = captureRoutes(registerFiles);
const callTracks = captureRoutes(registerTracks);

const fileRow = (filePath) =>
  db
    .prepare(
      `SELECT media.source, media.track_id, track.monitored, management.managed_by
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       LEFT JOIN library_management AS management
         ON management.entity_kind = 'album' AND management.entity_id = media.album_id
       WHERE media.path = ?`,
    )
    .all(filePath);

const fingerprint = async (filePath) => {
  const [info, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return { mtimeMs: info.mtimeMs, size: info.size, bytes: bytes.toString("base64") };
};

test("a read-only folder joins the Library and Aurral leaves its files alone", async () => {
  const folder = await makeFolder("joins");
  const filePath = await makeTrack(folder, "Kept Artist", "Kept Album", "Kept Song");
  const before = await fingerprint(filePath);

  const added = await callFiles("POST", "/files/read-only-folders", { body: { path: folder } });
  assert.equal(added.statusCode, 201);
  assert.deepEqual(
    added.body.folders.map((entry) => entry.path),
    [folder],
  );

  await scanConfiguredLibrary({ lidarrClient: lidarrOff });

  assert.deepEqual(fileRow(filePath), [
    {
      source: "readonly",
      track_id: fileRow(filePath)[0].track_id,
      monitored: 0,
      managed_by: "aurral",
    },
  ]);
  const listed = await callFiles("GET", "/files/read-only-folders");
  assert.equal(listed.body.folders[0].tracks, 1);
  assert.equal(listed.body.folders[0].readable, true);

  const deleted = await callTracks("DELETE", "/tracks/:id", {
    params: { id: String(fileRow(filePath)[0].track_id) },
  });
  assert.equal(deleted.statusCode, 409);
  assert.deepEqual(await fingerprint(filePath), before);
  assert.equal(fileRow(filePath).length, 1);
});

test("a read-only folder cannot overlap the Downloads Folder or another read-only folder", async () => {
  const folder = await makeFolder("overlap");
  await mkdir(path.join(folder, "Nested"), { recursive: true });
  const inDownloads = path.join(resolveDownloadRoot(), "Inside");
  await mkdir(inDownloads, { recursive: true });

  assert.equal(
    (await callFiles("POST", "/files/read-only-folders", { body: { path: folder } })).statusCode,
    201,
  );
  for (const rejected of [
    inDownloads,
    path.dirname(resolveDownloadRoot()),
    folder,
    path.join(folder, "Nested"),
    path.join(folder, "Missing"),
    "relative/path",
  ]) {
    const response = await callFiles("POST", "/files/read-only-folders", {
      body: { path: rejected },
    });
    assert.equal(response.statusCode, 400, rejected);
    assert.ok(response.body.message, rejected);
  }
  assert.deepEqual(dbOps.getJSONSetting("readOnlyFolders"), [folder]);
});

test("removing a read-only folder takes its music out of the Library and keeps the files", async () => {
  const folder = await makeFolder("removed");
  const filePath = await makeTrack(folder, "Gone Artist", "Gone Album", "Gone Song");
  await callFiles("POST", "/files/read-only-folders", { body: { path: folder } });
  await scanConfiguredLibrary({ lidarrClient: lidarrOff });
  assert.equal(fileRow(filePath).length, 1);

  const removed = await callFiles("DELETE", "/files/read-only-folders", { body: { path: folder } });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.body.folders, []);
  await scanConfiguredLibrary({ lidarrClient: lidarrOff });

  assert.deepEqual(fileRow(filePath), []);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM library_albums WHERE title = 'Gone Album'").pluck().get(),
    0,
  );
  assert.ok((await stat(filePath)).isFile());
});

test("a Lidarr root added as a read-only folder keeps its music when Lidarr is turned off", async () => {
  const folder = await makeFolder("lidarr-root");
  const filePath = await makeTrack(folder, "Moving Artist", "Moving Album", "Moving Song");
  await callFiles("POST", "/files/read-only-folders", { body: { path: folder } });

  await scanConfiguredLibrary({ lidarrClient: lidarrOn, lidarrRoots: [folder] });
  assert.deepEqual(
    fileRow(filePath).map((row) => row.source),
    ["lidarr"],
  );

  await scanConfiguredLibrary({ lidarrClient: lidarrOff, lidarrRoots: [folder] });
  const rows = fileRow(filePath);
  assert.deepEqual(
    rows.map((row) => [row.source, row.managed_by]),
    [["readonly", "aurral"]],
  );
  assert.ok((await stat(filePath)).isFile());
});

test("playlists use a read-only file in place and download their own copy once the folder is removed", async () => {
  const folder = await makeFolder("playlist");
  const filePath = await makeTrack(folder, "Shared Artist", "Shared Album", "Shared Song");
  const before = await fingerprint(filePath);
  await callFiles("POST", "/files/read-only-folders", { body: { path: folder } });
  await scanConfiguredLibrary({ lidarrClient: lidarrOff });

  const playlistId = `read-only-playlist-${process.pid}`;
  const reuse = await reuseTrackForPlaylist(
    { artistName: "Shared Artist", albumName: "Shared Album", trackName: "Shared Song" },
    playlistId,
    { targetPlaylistType: playlistId, skipHistory: true },
  );
  assert.equal(reuse.reused, true);
  assert.equal(reuse.finalPath, filePath);
  const job = downloadTracker.getJob(reuse.jobId);
  assert.equal(job.status, "done");
  assert.equal(job.externalPath, filePath);

  await downloadWorker.releaseLidarrFiles();
  assert.equal(downloadTracker.getJob(reuse.jobId).status, "done");

  await callFiles("DELETE", "/files/read-only-folders", { body: { path: folder } });
  vi.spyOn(downloadWorker, "start").mockResolvedValue(undefined);
  await processSystemTask({ kind: "read-only-folder-release", folders: [folder] });
  assert.equal(downloadTracker.getJob(reuse.jobId).status, "pending");
  assert.deepEqual(await fingerprint(filePath), before);
});
