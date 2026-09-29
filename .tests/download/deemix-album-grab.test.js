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
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
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
    } else if (url.pathname === "/api/search") {
      const title = /Second/i.test(url.searchParams.get("term") || "") ? "Second" : "First";
      res.end(JSON.stringify({ data: [{ id: title === "First" ? "1" : "2", title,
        artist: { name: "The Band" }, album: { id: "42", title: "Album" },
        duration: 1, link: `https://www.deezer.com/track/${title}` }] }));
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
  } finally {
    await mock.close();
  }
});
