import { Hono } from "hono";
import * as v from "valibot";
import { libraryManager } from "../../../services/libraryManager.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { logger } from "../../../services/logger.ts";
import { requestLibraryTrack } from "../../../services/libraryTrackRequests.ts";
import { resolveAurralOwnedTrackJob } from "../../../services/libraryTrackResearchService.ts";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.ts";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../../../services/downloadSourceService.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";
import { lidarrClient } from "../../../services/lidarrClient.ts";
import {
  recordAlbumRequested,
  recordAlbumSearchStarted,
} from "../../../services/aurralHistoryService.ts";
import { invalidateRequestsCache } from "../../requests.ts";
import {
  getActiveLidarrAlbums,
  getAllDownloadStatuses,
  getDownloadStatusesForAlbumIds,
  getLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
  type AlbumDownloadStatus,
} from "../../../services/lidarrStatusSnapshot.ts";

export const getActiveLibraryDownloads = async () => {
  const albums = new Set<string>();
  const artists = new Set<string>();
  const tracks = [];
  for (const job of downloadTracker.getActiveByPlaylistType("library")) {
    tracks.push({
      mbid: job.trackMbid || null,
      artistName: job.artistName,
      trackName: job.trackName,
    });
    if (!job.requestGroupId) continue;
    if (job.albumMbid) albums.add(job.albumMbid);
    if (job.artistMbid) artists.add(job.artistMbid);
  }
  try {
    for (const album of await getActiveLidarrAlbums()) {
      if (album.foreignAlbumId) albums.add(album.foreignAlbumId);
      if (album.artist?.foreignArtistId) artists.add(album.artist.foreignArtistId);
    }
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("downloads", "Failed to read active Lidarr downloads", {
      message: failure?.message,
    });
  }
  return { albums: [...albums], artists: [...artists], tracks };
};

const id = v.union([v.string(), v.number()]);
const text = v.optional(v.nullable(v.string()));
const count = v.optional(v.nullable(v.number()));

const researchInput = v.object({ albumId: v.optional(v.nullable(id)) });

const trackInput = v.object({
  artistName: text,
  trackName: text,
  albumName: text,
  artistMbid: text,
  albumMbid: text,
  releaseMbid: text,
  trackMbid: text,
  releaseYear: v.optional(v.nullable(id)),
  durationMs: count,
  trackNumber: count,
  discNumber: count,
  albumTrackCount: count,
  albumTrackTitles: v.optional(v.nullable(v.array(v.string()))),
  libraryTrackId: v.optional(v.nullable(id)),
});

const albumInput = v.object({ albumId: v.optional(id) });

const statusQuery = v.object({
  albumIds: v.optional(v.union([v.string(), v.array(v.string())])),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .post(
    "/downloads/tracks/:trackId/research",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", researchInput),
    async (c) => {
      const trackId = Number(c.req.param("trackId"));
      const { albumId } = c.req.valid("json");
      const sourceJob = resolveAurralOwnedTrackJob({ trackId, albumId });
      if (!sourceJob) {
        return c.json({ error: "Track is not an available Aurral-managed library track" }, 404);
      }
      if (!isAnyDownloadSourceConfigured()) {
        const message = getDownloadSourceNotConfiguredMessage();
        return c.json({ error: message, message }, 400);
      }
      if (downloadTracker.findActiveUpgradeJob(sourceJob)) {
        return c.json({ error: "A search for this track is already running" }, 409);
      }
      try {
        const result = await playlistOperationQueue.enqueuePayload({
          kind: "library-track-research",
          label: `library-track-research:${trackId}:${albumId || "all"}`,
          trackId,
          albumId: albumId ?? null,
        });
        return c.json({ success: true, queued: true, operationId: result.operationId }, 202);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("library", "Failed to queue track replacement search", failure?.message);
        return c.json(
          { error: "Failed to queue track replacement search", message: failure?.message },
          500,
        );
      }
    },
  )
  .post(
    "/downloads/tracks/:trackId/replacement-job",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", researchInput),
    (c) => {
      const { albumId } = c.req.valid("json");
      const job = resolveAurralOwnedTrackJob({ trackId: c.req.param("trackId"), albumId });
      if (!job) {
        return c.json({ error: "Track is not an available Aurral-managed library track" }, 404);
      }
      if (downloadTracker.findActiveUpgradeJob(job)) {
        return c.json({ error: "A search for this track is already running" }, 409);
      }
      return c.json({ id: job.id, trackName: job.trackName, artistName: job.artistName }, 200);
    },
  )
  .post(
    "/downloads/track",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", trackInput),
    async (c) => {
      const body = c.req.valid("json");
      const releaseMbid = String(body.releaseMbid || "").trim();
      const track = {
        artistName: String(body.artistName || "").trim(),
        trackName: String(body.trackName || "").trim(),
        albumName: String(body.albumName || "").trim() || null,
        artistMbid: String(body.artistMbid || "").trim() || null,
        albumMbid: String(body.albumMbid || "").trim() || null,
        releaseMbid: UUID_REGEX.test(releaseMbid) ? releaseMbid : null,
        trackMbid: String(body.trackMbid || "").trim() || null,
        releaseYear: String(body.releaseYear || "").trim() || null,
        durationMs: body.durationMs,
        trackNumber: body.trackNumber,
        discNumber: body.discNumber,
        albumTrackCount: body.albumTrackCount,
        albumTrackTitles: body.albumTrackTitles,
      };
      if (!track.artistName || !track.trackName) {
        return c.json({ error: "artistName and trackName are required" }, 400);
      }
      try {
        const result = await requestLibraryTrack(track, {
          libraryTrackId: body.libraryTrackId,
          user: c.var.user,
        });
        if (isFailure(result)) {
          return c.json(
            { error: result.error },
            isErrorStatus(result.statusCode) ? result.statusCode : 400,
          );
        }
        if (result.alreadyOwned) return c.json({ success: true, ...result }, 200);
        if (!result.reused) invalidateRequestsCache();
        return c.json({ success: true, ...result }, 202);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("library", "Failed to queue track acquisition", failure?.message);
        return c.json(
          { error: "Failed to queue track acquisition", message: failure?.message },
          500,
        );
      }
    },
  )
  .post(
    "/downloads/album",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", albumInput),
    async (c) => {
      try {
        const { albumId } = c.req.valid("json");
        if (!albumId) return c.json({ error: "albumId is required" }, 400);

        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return c.json({ error: "Lidarr is not configured" }, 400);
        }

        const album = await libraryManager.getAlbumById(albumId, { managedBy: "lidarr" });
        if (!album) return c.json({ error: "Album not found" }, 404);

        const artist = album.artistId
          ? await libraryManager.getArtistById(album.artistId, { managedBy: "lidarr" })
          : null;
        if (artist) {
          await libraryManager.ensureArtistMonitored(artist);
        }
        if (!album.monitored) {
          await libraryManager.updateAlbum(albumId, { monitored: true });
        }

        const settings = dbOps.getSettings();
        const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;

        if (searchOnAdd) await lidarrClient.triggerAlbumSearch(Number(albumId));
        invalidateAllDownloadStatusesCache();

        recordAlbumRequested({
          albumId,
          albumName: album.albumName,
          artistName: artist?.artistName || album.artistName,
          artistMbid: artist?.mbid || artist?.foreignArtistId,
          searching: searchOnAdd,
          user: c.var.user,
        });

        return c.json(
          {
            success: true,
            message: searchOnAdd ? "Album search triggered" : "Album added to library",
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.error("library", "Error initiating album download:", failure?.message);
        return c.json(
          { error: "Failed to initiate album download", message: failure?.message },
          500,
        );
      }
    },
  )
  .post(
    "/downloads/album/search",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", albumInput),
    async (c) => {
      const { albumId } = c.req.valid("json");
      try {
        if (!albumId) return c.json({ error: "albumId is required" }, 400);

        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return c.json({ error: "Lidarr is not configured" }, 400);
        }

        const album = await libraryManager.getAlbumById(albumId, { managedBy: "lidarr" });
        if (!album) return c.json({ error: "Album not found" }, 404);

        const artist = album.artistId
          ? await libraryManager.getArtistById(album.artistId, { managedBy: "lidarr" })
          : null;
        if (artist) {
          await libraryManager.ensureArtistMonitored(artist);
        }
        if (!album.monitored) {
          await libraryManager.updateAlbum(albumId, { monitored: true });
        }

        await lidarrClient.triggerAlbumSearch(Number(albumId));
        invalidateAllDownloadStatusesCache();

        recordAlbumSearchStarted({
          albumId,
          albumName: album.albumName,
          artistName: artist?.artistName || album.artistName,
          artistMbid: artist?.mbid || artist?.foreignArtistId,
          user: c.var.user,
        });

        return c.json({ success: true, message: "Album search triggered" }, 200);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("downloads", `Failed to trigger album search ${albumId}:`, {
          message: failure?.message,
        });
        return c.json({ error: "Failed to trigger album search", message: failure?.message }, 500);
      }
    },
  )
  .get("/downloads", async (c) => {
    try {
      if (!lidarrClient.isConfigured()) return c.json([], 200);
      const queue = (await getLidarrStatusSnapshot()).provider.queue;
      return c.json(
        queue.map((item) => ({
          id: item.id,
          type: "album",
          state: item.status || "queued",
          title: item.title,
          artistName: item.artist?.artistName,
          albumTitle: item.album?.title,
          progress:
            item.size && item.sizeleft !== undefined
              ? Math.round((1 - item.sizeleft / item.size) * 100)
              : 0,
          source: "lidarr",
        })),
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to fetch downloads", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/downloads/status", noCache, validate("query", statusQuery), async (c) => {
    try {
      const { albumIds } = c.req.valid("query");
      if (!albumIds) return c.json({ error: "albumIds query parameter is required" }, 400);
      const albumIdArray = Array.isArray(albumIds) ? albumIds : albumIds.split(",");
      const aurralPrefix = "aurral:";
      const aurralIds = albumIdArray.filter((id) => id.startsWith(aurralPrefix));
      const statuses: Record<
        string,
        | AlbumDownloadStatus
        | Extract<
            ReturnType<typeof libraryManager.getAurralAlbumStatuses>[number],
            { error?: undefined }
          >
      > = await getDownloadStatusesForAlbumIds(
        albumIdArray.filter((id) => !id.startsWith(aurralPrefix)),
      );
      const aurralStatuses = libraryManager.getAurralAlbumStatuses(
        aurralIds.map((key) => key.slice(aurralPrefix.length)),
      );
      aurralIds.forEach((key, index) => {
        const status = aurralStatuses[index];
        if (status && status.error === undefined) statuses[key] = status;
      });
      return c.json(statuses, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch download status", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/downloads/active", noCache, async (c) => {
    try {
      return c.json(await getActiveLibraryDownloads(), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch active downloads", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/downloads/status/all", noCache, async (c) => {
    try {
      return c.json(await getAllDownloadStatuses(), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch download status", message: asAppError(error)?.message },
        500,
      );
    }
  });
