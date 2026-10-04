import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "../helpers/backendTestHarness.js";

const execFileAsync = promisify(execFile);
const [state, { dbOps }, { downloadTracker }, { processDeemixPipelinePayload }] =
  await setupIsolatedBackend(
    "deemix-album-grab",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/deemixOrchestrator.js",
  );

test.after(async () => cleanupIsolatedState(state));

test("one deemix album queue fills verified siblings and retries only a missing track", async () => {
  const downloads = join(state.baseDir, "deemix-downloads");
  await mkdir(downloads, { recursive: true });
  const firstPath = join(downloads, "01 First.flac");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "flac",
    "-metadata", "title=First", "-metadata", "artist=The Band", firstPath]);

  let added = 0;
  let removed = 0;
  const mock = await createMockHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/connect") {
      res.end(JSON.stringify({ autologin: false, currentUser: { name: "Disposable" } }));
    } else if (url.pathname === "/api/search" && url.searchParams.get("type") === "album") {
      res.end(JSON.stringify({ data: [{ id: "42", title: "Album",
        artist: { name: "The Band" }, link: "https://www.deezer.com/album/42" }] }));
    } else if (url.pathname === "/api/getTracklist") {
      res.end(JSON.stringify({ id: "42", tracks: ["First", "Second"].map((title, index) => ({
        id: String(index + 1), title, artist: { name: "The Band" }, duration: 1,
        track_position: index + 1, disk_number: 1,
      })) }));
    } else if (url.pathname === "/api/addToQueue") {
      added += 1;
      res.end(JSON.stringify({ result: true, data: { obj: { uuid: "album_42_9" } } }));
    } else if (url.pathname === "/api/getQueue") {
      res.end(JSON.stringify({ queue: { album_42_9: { type: "album", status: "withErrors",
        files: [{ path: firstPath }], downloaded: 1, failed: 1 } } }));
    } else if (url.pathname === "/api/removeFromQueue") {
      removed += 1;
      res.end(JSON.stringify({ result: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  try {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({ ...settings, integrations: {
      ...settings.integrations, deemix: { enabled: true, url: mock.url, bitrate: 9 },
    } });
    const group = "deemix-album-group";
    const ids = ["First", "Second"].map((trackName, index) => downloadTracker.addJob({
      artistName: "The Band", albumName: "Album", albumMbid: "album-mbid",
      trackName, trackNumber: index + 1, durationMs: 1000,
      requestGroupId: group, albumTrackCount: 2,
      albumTrackTitles: ["First", "Second"],
    }, "library"));
    downloadTracker.setDownloading(ids[1]);
    const helpers = { failOrTryNextSource: (_, __, reason) => {
      throw new Error(`unexpected source fallback: ${reason}`);
    } };
    const initial = { phase: "search", source: "deemix", jobId: ids[0],
      playlistId: "library", playlistGeneration: 0, destination: "The Band/Album",
      albumGrab: true, albumGroupJobIds: ids };
    const searched = await processDeemixPipelinePayload(initial, helpers);
    assert.equal(searched.phase, "download");
    const queued = await processDeemixPipelinePayload(searched, helpers);
    assert.equal(queued.phase, "poll");
    const polled = await processDeemixPipelinePayload(queued, helpers);
    assert.equal(polled.phase, "finalize");
    await processDeemixPipelinePayload(polled, helpers);
    assert.equal(added, 1);
    assert.equal(removed, 1);
    assert.equal(downloadTracker.getJob(ids[0]).status, "done");
    assert.equal(downloadTracker.getJob(ids[1]).status, "pending");
    assert.match(downloadTracker.getJob(ids[1]).error, /not in the album download/);
    assert.ok((await stat(downloadTracker.getJob(ids[0]).finalPath)).isFile());
    const { getAurralHistoryRequests } = await import("../../backend/services/aurralHistoryService.js");
    const activity = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId));
    assert.equal(activity.length, 2);
    const imported = activity.find((item) => item.jobId === ids[0]);
    assert.equal(imported.downloadMethod, "album");
    assert.equal(imported.actualDownloadSource, "deemix");
    assert.equal(imported.albumGrab.phase, "tracks");
    assert.match(imported.albumGrab.fallbackReason, /not in the album download/);
    assert.equal(activity.find((item) => item.jobId === ids[1]).actualDownloadSource, null);
  } finally {
    await mock.close();
  }
});

function albumJobs(group) {
  return ["First", "Second"].map((trackName, index) => downloadTracker.addJob({
    artistName: "The Band", albumName: "Album", albumMbid: group,
    trackName, trackNumber: index + 1, durationMs: 180000,
    requestGroupId: group, albumTrackCount: 2, albumTrackTitles: ["First", "Second"],
  }, "library"));
}

async function searchWith(client, ids) {
  return processDeemixPipelinePayload({ phase: "search", source: "deemix", jobId: ids[0],
    albumGrab: true, albumGroupJobIds: ids }, {
    failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }),
  });
}

const albumTrack = (title, index, overrides = {}) => ({ id: `${index}`, title, artist: "The Band",
  durationSec: 180, trackNumber: index + 1, readable: true, ...overrides });

test("deemix album grab picks the album whose tracklist holds the requested tracks", async (t) => {
  const { getDownloadClient } = await import("../../backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("deemix");
  const tracklists = {
    other: ["First", "Second"].map((title, index) => albumTrack(title, index)),
    wrong: ["Unrelated", "Songs"].map((title, index) => albumTrack(title, index)),
    locked: ["First", "Second"].map((title, index) => albumTrack(title, index, { readable: false })),
    deluxe: ["First", "Second", "Bonus"].map((title, index) => albumTrack(title, index)),
  };
  t.mock.method(client, "searchAlbums", async () => [
    { id: "other", title: "Other Album", url: "https://album.invalid/other" },
    { id: "wrong", title: "Album", url: "https://album.invalid/wrong" },
    { id: "locked", title: "Album", url: "https://album.invalid/locked" },
    { id: "deluxe", title: "Album (Deluxe Edition)", url: "https://album.invalid/deluxe" },
  ]);
  const tracklist = t.mock.method(client, "getAlbumTracks", async (id) => tracklists[id]);
  const result = await searchWith(client, albumJobs("deemix-tracklist"));
  assert.equal(result.phase, "download");
  assert.deepEqual(result.candidates.map((candidate) => candidate.raw.albumId), ["deluxe"]);
  assert.ok(!tracklist.mock.calls.some((call) => call.arguments[0] === "other"));
});

test("deemix album grab tries the plain album query when the advanced one finds nothing", async (t) => {
  const { getDownloadClient } = await import("../../backend/services/download/downloadClientSettings.js");
  const client = getDownloadClient("deemix");
  const search = t.mock.method(client, "searchAlbums", async (query) => (query.includes("artist:")
    ? [] : [{ id: "42", title: "Album", url: "https://album.invalid/42" }]));
  t.mock.method(client, "getAlbumTracks", async () =>
    ["First", "Second"].map((title, index) => albumTrack(title, index)));
  const result = await searchWith(client, albumJobs("deemix-plain"));
  assert.equal(search.mock.callCount(), 2);
  assert.equal(result.candidates[0].raw.albumId, "42");
});
