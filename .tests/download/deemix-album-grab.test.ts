import { createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "../helpers/backendTestHarness.ts";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.ts";

const execFileAsync = promisify(execFile);

type DeemixPayload = Parameters<typeof processDeemixPipelinePayload>[0];
const [
  state,
  { dbOps },
  { downloadTracker },
  { processDeemixPipelinePayload },
  { downloadWorker },
  { beginDownloadAttempt, setActiveDownloadAttemptId },
] = await setupIsolatedBackend(
  "deemix-album-grab",
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/deemixOrchestrator.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellation.ts"),
);

afterAll(async () => cleanupIsolatedState(state));

// Serves the requested release, in the group `${id}-group`, from the
// metadata provider and returns its ID.
async function serveRelease(
  t: import("vite-plus/test").TestContext,
  id: string,
  title: string,
  tracks: [title: string, durationMs: number, artist?: string][],
  { artist = "The Band", artistId = "album-artist" }: { artist?: string; artistId?: string } = {},
) {
  const trackArtists = [
    ...new Set(tracks.map(([, , trackArtist]) => trackArtist).filter((name) => name != null)),
  ].map((name) => ({ id: `${name}-artist`, name }));
  await serveGroups(t, [
    brainzmashGroup({
      id: `${id}-group`,
      title,
      artist,
      artistId,
      trackArtists,
      releases: [
        {
          id,
          tracks: tracks.map(([trackTitle, durationMs, trackArtist]) => ({
            title: trackTitle,
            durationMs,
            ...(trackArtist ? { artistId: `${trackArtist}-artist` } : {}),
          })),
        },
      ],
    }),
  ]);
  return id;
}

test("one deemix album queue fills verified siblings and retries only a missing track elsewhere", async (t) => {
  const downloads = join(state.baseDir, "deemix-downloads");
  await mkdir(downloads, { recursive: true });
  const firstPath = join(downloads, "01 First.flac");
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    "1",
    "-c:a",
    "flac",
    "-metadata",
    "title=First",
    "-metadata",
    "artist=The Band",
    firstPath,
  ]);

  let added = 0;
  let removed = 0;
  const mock = await createMockHttpServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/connect") {
      res.end(JSON.stringify({ autologin: false, currentUser: { name: "Disposable" } }));
    } else if (url.pathname === "/api/search" && url.searchParams.get("type") === "track") {
      res.end(
        JSON.stringify({
          data: ["42", "77"].map((albumId) => ({
            id: `${albumId}-2`,
            title: "Second",
            artist: { name: "The Band" },
            album: { id: albumId, title: "Album" },
            duration: 1,
          })),
        }),
      );
    } else if (url.pathname === "/api/search" && url.searchParams.get("type") === "album") {
      res.end(
        JSON.stringify({
          data: [
            {
              id: "42",
              title: "Album",
              artist: { name: "The Band" },
              link: "https://www.deezer.com/album/42",
            },
          ],
        }),
      );
    } else if (url.pathname === "/api/getTracklist") {
      res.end(
        JSON.stringify({
          id: "42",
          tracks: ["First", "Second"].map((title, index) => ({
            id: String(index + 1),
            title,
            artist: { name: "The Band" },
            duration: 1,
            track_position: index + 1,
            disk_number: 1,
          })),
        }),
      );
    } else if (url.pathname === "/api/addToQueue") {
      added += 1;
      res.end(JSON.stringify({ result: true, data: { obj: { uuid: "album_42_9" } } }));
    } else if (url.pathname === "/api/getQueue") {
      res.end(
        JSON.stringify({
          queue: {
            album_42_9: {
              type: "album",
              status: "withErrors",
              files: [{ path: firstPath }],
              downloaded: 1,
              failed: 1,
            },
          },
        }),
      );
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
    dbOps.updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        deemix: { enabled: true, url: mock.url, bitrate: 9 },
      },
    });
    const group = "deemix-album-group";
    const ids = ["First", "Second"].map((trackName, index) =>
      createTrackedJob(
        downloadTracker,
        {
          artistName: "The Band",
          albumName: "Album",
          albumMbid: "deemix-two-group",
          trackName,
          trackNumber: index + 1,
          durationMs: 1000,
          requestGroupId: group,
          albumTrackCount: 2,
          albumTrackTitles: ["First", "Second"],
        },
        "library",
      ),
    );
    assert.ok(ids.every((value) => value != null));
    downloadTracker.setDownloading(ids[1]);
    const downloadAttemptId = beginDownloadAttempt(ids[0]);
    setActiveDownloadAttemptId(ids[1], downloadAttemptId);
    const helpers = {
      failOrTryNextSource: (_: unknown, __: unknown, reason: string) => {
        throw new Error(`unexpected source fallback: ${reason}`);
      },
    };
    const initial = {
      phase: "search" as const,
      source: "deemix",
      jobId: ids[0],
      downloadAttemptId,
      playlistId: "library",
      playlistGeneration: 0,
      destination: "The Band/Album",
      albumGrab: true,
      albumGroupJobIds: ids,
      releaseMbid: await serveRelease(t, "deemix-two", "Album", [
        ["First", 1000],
        ["Second", 1000],
      ]),
    };
    const searched = await processDeemixPipelinePayload(initial, helpers);
    assert.ok(searched != null);
    assert.equal(searched.phase, "download");
    const queued = await processDeemixPipelinePayload(searched as DeemixPayload, helpers);
    assert.ok(queued != null);
    assert.equal(queued.phase, "poll");
    const polled = await processDeemixPipelinePayload(queued as DeemixPayload, helpers);
    assert.ok(polled != null);
    assert.equal(polled.phase, "finalize");
    const start = vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
    await processDeemixPipelinePayload(polled as DeemixPayload, helpers);
    for (let tick = 0; tick < 100 && start.mock.calls.length === 0; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(start.mock.calls.length, 1);
    assert.equal(added, 1);
    assert.equal(removed, 1);
    assert.equal(trackedJob(downloadTracker, ids[0]).status, "done");
    assert.equal(trackedJob(downloadTracker, ids[1]).status, "pending");
    assert.match(trackedJob(downloadTracker, ids[1]).error!, /not in the album download/);
    assert.ok((await stat(trackedJob(downloadTracker, ids[0]).finalPath!)).isFile());
    const { getAurralHistoryRequests } =
      await import("../../backend/services/aurralHistoryService.ts");
    const activity = (await getAurralHistoryRequests()).filter((item) => ids.includes(item.jobId!));
    assert.equal(activity.length, 2);
    const imported = activity.find((item) => item.jobId === ids[0]);
    assert.ok(imported != null);
    assert.equal(imported.downloadMethod, "album");
    assert.equal(imported.actualDownloadSource, "deemix");
    assert.equal(imported.albumGrab!.phase, "tracks");
    assert.match(imported.albumGrab!.fallbackReason!, /not in the album download/);
    assert.equal(activity.find((item) => item.jobId === ids[1])!.actualDownloadSource, null);

    const retryPayload = {
      ...initial,
      jobId: ids[1],
      downloadAttemptId: beginDownloadAttempt(ids[1]),
      albumGrab: false,
      albumGroupJobIds: undefined,
      releaseMbid: null,
    };
    const retry = await processDeemixPipelinePayload(retryPayload, helpers);
    assert.deepEqual(
      deemixCandidates(retry).map((candidate) => candidate.raw.id),
      ["77-2"],
    );
  } finally {
    await mock.close();
  }
});

function albumJobs(group: string) {
  return ["First", "Second"].map((trackName, index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "The Band",
        albumName: "Album",
        albumMbid: "deemix-standard-group",
        trackName,
        trackNumber: index + 1,
        durationMs: 180000,
        requestGroupId: group,
        albumTrackCount: 2,
        albumTrackTitles: ["First", "Second"],
      },
      "library",
    ),
  );
}

const serveStandard = (t: import("vite-plus/test").TestContext) =>
  serveRelease(t, "deemix-standard", "Album", [
    ["First", 180000],
    ["Second", 180000],
  ]);

function deemixCandidates(result: Awaited<ReturnType<typeof processDeemixPipelinePayload>>) {
  assert.ok(result?.candidates != null);
  return result.candidates as NonNullable<DeemixPayload["candidates"]>;
}

const albumEntry = (id: string, title: string, artist = "The Band") => ({
  id,
  title,
  artist,
  url: `https://album.invalid/${id}`,
});

async function searchWith(ids: string[], releaseMbid: string) {
  const payload = {
    phase: "search" as const,
    source: "deemix",
    jobId: ids[0],
    albumGrab: true,
    albumGroupJobIds: ids,
    releaseMbid,
  };
  return processDeemixPipelinePayload(payload, {
    failOrTryNextSource: async (_payload, _job, reason) => {
      throw new Error(`unexpected source fallback: ${reason}`);
    },
  });
}

const albumTrack = (
  title: string,
  index: number,
  overrides: { readable?: boolean; artist?: string } = {},
) => ({
  id: `${index}`,
  title,
  artist: "The Band",
  album: "Album",
  albumId: "album",
  albumUrl: "https://album.invalid/album",
  url: `https://track.invalid/${index}`,
  durationSec: 180,
  trackNumber: index + 1,
  discNumber: 1,
  readable: true,
  ...overrides,
});

test("deemix album grab takes only an album whose whole tracklist is the requested release", async (t) => {
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  const tracklists = {
    other: ["First", "Second"].map((title, index) => albumTrack(title, index)),
    wrong: ["Unrelated", "Songs"].map((title, index) => albumTrack(title, index)),
    locked: ["First", "Second"].map((title, index) =>
      albumTrack(title, index, { readable: false }),
    ),
    deluxe: ["First", "Second", "Bonus"].map((title, index) => albumTrack(title, index)),
    hidden: ["First", "Second", "Bonus"].map((title, index) =>
      albumTrack(title, index, { readable: index < 2 }),
    ),
    exact: ["First", "Second"].map((title, index) => albumTrack(title, index)),
  };
  vi.spyOn(client, "searchAlbums").mockImplementation(async () => [
    albumEntry("other", "Other Album"),
    albumEntry("wrong", "Album"),
    albumEntry("locked", "Album"),
    albumEntry("deluxe", "Album (Deluxe Edition)"),
    albumEntry("hidden", "Album"),
    albumEntry("exact", "Album"),
  ]);
  const tracklist = vi
    .spyOn(client, "getAlbumTracks")
    .mockImplementation(async (id) => tracklists[id as keyof typeof tracklists]);
  const result = await searchWith(albumJobs("deemix-tracklist"), await serveStandard(t));
  assert.ok(result != null);
  assert.equal(result.phase, "download");
  assert.deepEqual(
    deemixCandidates(result).map((candidate) => [
      candidate.raw.albumId,
      candidate.kind,
      candidate.releaseVerified,
    ]),
    [["exact", "album", true]],
  );
  assert.ok(!tracklist.mock.calls.some((call) => call[0] === "other"));
});

test("deemix album grab tries the plain album query when the advanced one finds no fitting album", async (t) => {
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  const search = vi
    .spyOn(client, "searchAlbums")
    .mockImplementation(async (query) => [
      query.includes("artist:") ? albumEntry("single", "Album") : albumEntry("42", "Album"),
    ]);
  vi.spyOn(client, "getAlbumTracks").mockImplementation(async (id) =>
    (id === "single" ? ["Other"] : ["First", "Second"]).map((title, index) =>
      albumTrack(title, index),
    ),
  );
  const result = await searchWith(albumJobs("deemix-plain"), await serveStandard(t));
  assert.ok(result != null);
  assert.equal(search.mock.calls.length, 2);
  assert.equal(deemixCandidates(result)[0].raw.albumId, "42");
});

test("deemix searches a compilation by its album title alone", async (t) => {
  const { getDownloadClient } =
    await import("../../backend/services/download/downloadClientSettings.ts");
  const client = getDownloadClient("deemix");
  const search = vi
    .spyOn(client, "searchAlbums")
    .mockImplementation(async () => [
      albumEntry("mix", "Guardians of the Galaxy: Awesome Mix, Vol. 1", ""),
    ]);
  vi.spyOn(client, "getAlbumTracks").mockImplementation(async () => [
    albumTrack("Hooked on a Feeling", 0, { artist: "Blue Swede" }),
    albumTrack("Go All the Way", 1, { artist: "Raspberries" }),
  ]);
  const albumName =
    "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack";
  const ids = [
    ["Blue Swede", "Hooked on a Feeling"],
    ["Raspberries", "Go All the Way"],
  ].map(([artistName, trackName], index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName,
        trackName,
        trackNumber: index + 1,
        durationMs: 180000,
        albumName,
        albumMbid: "deemix-compilation-group",
        requestGroupId: "deemix-compilation",
      },
      "library",
    ),
  );
  const result = await searchWith(
    ids,
    await serveRelease(
      t,
      "deemix-compilation",
      albumName,
      [
        ["Hooked on a Feeling", 180000, "Blue Swede"],
        ["Go All the Way", 180000, "Raspberries"],
      ],
      { artist: "Various Artists", artistId: "89ad4ac3-39f7-470e-963a-56509c546377" },
    ),
  );
  assert.ok(result != null);
  assert.equal(deemixCandidates(result)[0].raw.albumId, "mix");
  assert.ok(search.mock.calls.every((call) => !/Blue Swede|Raspberries/.test(call[0])));
});
