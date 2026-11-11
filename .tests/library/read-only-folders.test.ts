import * as v from "valibot";
import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
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
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});
vi.mock("../../backend/services/metadataProviderBudget.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend/services/metadataProviderBudget.ts")>()),
  reserveMetadataProviderRequest: () => 0,
}));

const [
  isolatedState,
  { db },
  { dbOps },
  { api },
  { scanConfiguredLibrary },
  { resolveDownloadRoot },
  { reuseTrackForPlaylist },
  { downloadTracker },
  { downloadWorker },
  { processSystemTask },
  { clearScheduledLibraryScan },
  { saveAppSettings },
] = await setupIsolatedBackend(
  "read-only-folders",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/libraryIndexService.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/downloadJobs/fileReuse.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/libraryScanWorker.ts"),
  () => import("../../backend/services/appSettings.ts"),
);

const temporaryFolders: string[] = [];

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

async function makeFolder(name: string) {
  const folder = await mkdtemp(path.join(tmpdir(), `aurral-read-only-${name}-`));
  temporaryFolders.push(folder);
  return folder;
}

async function makeTrack(
  root: string,
  artist: string,
  album: string,
  title: string,
  trackNumber = 1,
) {
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

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

async function callLibrary(method: string, routePath: string, body?: { path: string }) {
  const response = await app.request(
    `/library${routePath}`,
    body
      ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method },
  );
  const responseBody: {
    folders: { path: string; tracks?: number; readable?: boolean }[];
    message?: string;
    error?: string;
  } = await response.json();
  return { status: response.status, body: responseBody };
}

const fileRow = (filePath: string) =>
  db
    .prepare<unknown[], { source: string; track_id: number; monitored: number }>(
      `SELECT media.source, media.track_id, track.monitored
       FROM library_media_files AS media
       JOIN library_tracks AS track ON track.id = media.track_id
       WHERE media.path = ?`,
    )
    .all(filePath);

const fingerprint = async (filePath: string) => {
  const [info, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return { mtimeMs: info.mtimeMs, size: info.size, bytes: bytes.toString("base64") };
};

test("a read-only folder joins the Library and Aurral leaves its files alone", async () => {
  const folder = await makeFolder("joins");
  const filePath = await makeTrack(folder, "Kept Artist", "Kept Album", "Kept Song");
  const before = await fingerprint(filePath);

  const added = await callLibrary("POST", "/files/read-only-folders", { path: folder });
  assert.equal(added.status, 201);
  assert.deepEqual(
    added.body.folders.map((entry) => entry.path),
    [folder],
  );

  await scanConfiguredLibrary();

  assert.deepEqual(fileRow(filePath), [
    {
      source: "readonly",
      track_id: requireFixture(fileRow(filePath)[0]).track_id,
      monitored: 0,
    },
  ]);
  const listed = await callLibrary("GET", "/files/read-only-folders");
  assert.equal(listed.body.folders[0]?.tracks, 1);
  assert.equal(listed.body.folders[0]?.readable, true);

  const deleted = await callLibrary(
    "DELETE",
    `/tracks/${requireFixture(fileRow(filePath)[0]).track_id}`,
  );
  assert.equal(deleted.status, 409);
  assert.deepEqual(await fingerprint(filePath), before);
  assert.equal(fileRow(filePath).length, 1);
});

test("a read-only folder cannot overlap the Library folder or another read-only folder", async () => {
  const folder = await makeFolder("overlap");
  await mkdir(path.join(folder, "Nested"), { recursive: true });
  const inDownloads = path.join(resolveDownloadRoot(), "Inside");
  await mkdir(inDownloads, { recursive: true });

  assert.equal(
    (await callLibrary("POST", "/files/read-only-folders", { path: folder })).status,
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
    const response = await callLibrary("POST", "/files/read-only-folders", { path: rejected });
    assert.equal(response.status, 400, rejected);
    assert.ok(response.body.message, rejected);
  }
  assert.deepEqual(dbOps.getJSONSetting("readOnlyFolders", v.unknown()), [folder]);

  const libraryFolder = resolveDownloadRoot();
  dbOps.setJSONSetting("readOnlyFolders", [folder, libraryFolder]);
  assert.ok("settings" in (await saveAppSettings({ downloadFolderPath: libraryFolder })));
  assert.match(
    String((await saveAppSettings({ downloadFolderPath: path.join(folder, "Nested") })).error),
    /cannot overlap the read-only folder/,
  );
  assert.equal(resolveDownloadRoot(), libraryFolder);
});

test("an unreadable saved read-only folder entry keeps the other folders", async () => {
  const folder = await makeFolder("kept-entry");
  dbOps.setJSONSetting("readOnlyFolders", [folder, null]);

  const listed = await callLibrary("GET", "/files/read-only-folders");
  assert.deepEqual(
    listed.body.folders.map((entry) => entry.path),
    [folder],
  );
});

test("removing a read-only folder takes its music out of the Library and keeps the files", async () => {
  const folder = await makeFolder("removed");
  const filePath = await makeTrack(folder, "Gone Artist", "Gone Album", "Gone Song");
  await callLibrary("POST", "/files/read-only-folders", { path: folder });
  await scanConfiguredLibrary();
  assert.equal(fileRow(filePath).length, 1);

  const removed = await callLibrary("DELETE", "/files/read-only-folders", { path: folder });
  assert.equal(removed.status, 200);
  assert.deepEqual([...removed.body.folders], []);
  await scanConfiguredLibrary();

  assert.deepEqual(fileRow(filePath), []);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM library_albums WHERE title = 'Gone Album'").pluck().get(),
    0,
  );
  assert.ok((await stat(filePath)).isFile());
});

test("a scan kept to the Library folder reaches the read-only folders that hold its paths, and no others", async (t) => {
  const inside = path.join(resolveDownloadRoot(), "Shared Folder");
  t.onTestFinished(() => rm(inside, { recursive: true, force: true }));
  const outside = await makeFolder("outside");
  dbOps.setJSONSetting("readOnlyFolders", [inside, outside]);
  const outsideKept = await makeTrack(outside, "Outside Artist", "Outside Album", "Kept Song");
  await scanConfiguredLibrary();
  const sources = (filePath: string) => fileRow(filePath).map((row) => row.source);

  const named = await makeTrack(inside, "Inside Artist", "Inside Album", "Named Song");
  const outsideNamed = await makeTrack(outside, "Outside Artist", "Outside Album", "Named Song", 2);
  await scanConfiguredLibrary({
    includeReadOnly: false,
    changedPaths: [named, outsideNamed],
  });
  assert.deepEqual(sources(named), ["readonly"]);
  assert.deepEqual(sources(outsideNamed), ["readonly"]);

  const walked = await makeTrack(inside, "Inside Artist", "Inside Album", "Walked Song", 2);
  const outsideUnseen = await makeTrack(outside, "Outside Artist", "Outside Album", "New Song", 3);
  await scanConfiguredLibrary({ includeReadOnly: false });
  assert.deepEqual(sources(walked), ["readonly"]);
  assert.deepEqual(sources(outsideUnseen), []);
  assert.deepEqual(sources(outsideKept), ["readonly"]);
});

test("playlists use a read-only file in place and download their own copy once the folder is removed", async () => {
  const folder = await makeFolder("playlist");
  const filePath = await makeTrack(folder, "Shared Artist", "Shared Album", "Shared Song");
  const before = await fingerprint(filePath);
  await callLibrary("POST", "/files/read-only-folders", { path: folder });
  await scanConfiguredLibrary();

  const playlistId = `read-only-playlist-${process.pid}`;
  const reuse = await reuseTrackForPlaylist(
    { artistName: "Shared Artist", albumName: "Shared Album", trackName: "Shared Song" },
    playlistId,
    { targetPlaylistType: playlistId, skipHistory: true },
  );
  assert.equal(reuse.reused, true);
  assert.equal(reuse.finalPath, filePath);
  const job = downloadTracker.getJob(reuse.jobId);
  assert.ok(job != null);
  assert.equal(job.status, "done");
  assert.equal(job.externalPath, filePath);

  vi.spyOn(downloadWorker, "start").mockResolvedValue(undefined);
  await callLibrary("DELETE", "/files/read-only-folders", { path: folder });
  await processSystemTask({ kind: "read-only-folder-release", folders: [folder] });
  assert.equal(downloadTracker.getJob(reuse.jobId)!.status, "pending");
  assert.deepEqual(await fingerprint(filePath), before);
});
