import { extname } from "node:path";
import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import type { DownloadJob } from "../services/downloadJobs/downloadTracker.ts";
import { clearPlayerQueue, getPlayerQueue, savePlayerQueue } from "../services/playQueueService.ts";
import { toQueueTracks } from "../services/queueTracks.ts";

const MAX_ENTRIES = 1000;

const device = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

const playQueueInput = v.object({
  streamPaths: v.pipe(v.array(v.pipe(v.string(), v.maxLength(500))), v.maxLength(MAX_ENTRIES)),
  current: v.pipe(v.number(), v.integer(), v.minValue(0)),
  positionMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  device,
});

function entryForStreamPath(path: string) {
  const library = /^\/library\/stream\/[^/]+\/(\d+)$/.exec(path);
  if (library) return { trackId: Number(library[1]) };
  const playlist = /^\/playlists\/stream\/([^/]+)$/.exec(path);
  if (!playlist?.[1]) return null;
  try {
    return { jobId: decodeURIComponent(playlist[1]) };
  } catch {
    return null;
  }
}

const jobQueueTrack = (job: DownloadJob) => ({
  id: String(job.id),
  title: job.trackName || "Unknown Track",
  artist: job.artistName || "Unknown Artist",
  album: job.albumName || "Unknown Album",
  streamPath: `/playlists/stream/${encodeURIComponent(job.id)}`,
  streamFormat:
    extname(job.finalPath || "")
      .slice(1)
      .toLowerCase() || null,
  quality: null,
  durationMs: job.durationMs ?? null,
  artistMbid: job.artistMbid ?? null,
  albumMbid: job.albumMbid ?? null,
  trackMbid: job.trackMbid ?? null,
  libraryTrackId: null,
  libraryAlbumId: null,
  libraryArtistId: null,
  artworkUrl: null,
  artworkSource: null,
});

export default new Hono<AppEnv>()
  .basePath("/play-queue")
  .use(requireAuth, requireUserAccount, noCache)
  .get("/", (c) => {
    const saved = getPlayerQueue(c.var.user);
    if (!saved) return c.json({ queue: null }, 200);
    const library = new Map(
      toQueueTracks(saved.entries.flatMap((entry) => entry?.trackId ?? [])).map((track) => [
        track.libraryTrackId,
        track,
      ]),
    );
    const tracks = saved.entries.flatMap((entry, index) => {
      const track = entry?.job
        ? jobQueueTrack(entry.job)
        : entry?.trackId != null && library.get(entry.trackId);
      return track ? [{ track, index }] : [];
    });
    if (!tracks.length) return c.json({ queue: null }, 200);
    const current = tracks.findIndex(({ index }) => index === saved.current);
    return c.json(
      {
        queue: {
          changed: saved.changed,
          changedBy: saved.changedBy,
          tracks: tracks.map(({ track }) => track),
          currentIndex: Math.max(0, current),
          positionMs: current < 0 ? 0 : saved.positionMs,
        },
      },
      200,
    );
  })
  .put("/", validate("json", playQueueInput), (c) => {
    const { streamPaths, ...queue } = c.req.valid("json");
    const changed = savePlayerQueue(c.var.user, {
      ...queue,
      entries: streamPaths.map(entryForStreamPath),
    });
    return c.json({ changed: changed ?? null }, 200);
  })
  .delete(
    "/",
    validate(
      "json",
      v.object({ device, changed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0) }),
    ),
    (c) => {
      const { device, changed } = c.req.valid("json");
      clearPlayerQueue(c.var.user, device, changed);
      return c.body(null, 204);
    },
  );
