import { Hono } from "hono";
import * as v from "valibot";
import { libraryManager } from "../../../services/libraryManager.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  albumHasTrackFiles,
  classifyLidarrDownloadEvent,
  parseLidarrSearchContext,
  readLidarrQueueItemStatus,
  resolveAlbumSearchOutcome,
} from "../../../services/albumSearchState.ts";
import type {
  LidarrCommand,
  LidarrHistoryItem,
  LidarrPage,
  LidarrQueueItem,
} from "../../../services/lidarrClient.ts";
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

type LidarrProviderSnapshot = {
  queue: LidarrQueueItem[] | LidarrPage<LidarrQueueItem>;
  history: LidarrHistoryItem[] | LidarrPage<LidarrHistoryItem>;
  commands: LidarrCommand[] | LidarrPage<LidarrCommand>;
};

type AlbumDownloadStatus = { status: string; updatedAt: string };

type LidarrStatusSnapshot = {
  provider: LidarrProviderSnapshot;
  statuses: Record<string, AlbumDownloadStatus>;
  updatedAt: string | null;
  active: boolean;
  stale: boolean;
  error: string | null;
};

type LidarrStatusCache = {
  snapshot: LidarrStatusSnapshot | null;
  pending: Promise<LidarrStatusSnapshot> | null;
  failures: number;
  checkedAt: number;
  nextRefreshAt: number;
  revision: number;
};

const STALE_GRABBED_MS = 15 * 60 * 1000;
const ACTIVE_STATUS_CACHE_MS = 10 * 1000;
const IDLE_STATUS_CACHE_MS = 60 * 1000;
const MAX_STATUS_RETRY_MS = 2 * 60 * 1000;
let allDownloadStatusesCache: LidarrStatusCache = {
  snapshot: null,
  pending: null,
  failures: 0,
  checkedAt: 0,
  nextRefreshAt: 0,
  revision: 0,
};

const activeDownloadStatuses = new Set(["searching", "downloading", "processing"]);

const snapshotHasActiveWork = (statuses: Record<string, AlbumDownloadStatus>) =>
  Object.values(statuses || {}).some((status) => activeDownloadStatuses.has(status?.status));

const invalidateActivityRequestsCache = () =>
  import("../../requests.ts")
    .then(({ invalidateRequestsCache }) => invalidateRequestsCache())
    .catch(() => {});

export const getDownloadStatusesForAlbumIds = async (
  albumIdArrayInput: unknown,
  snapshot: LidarrProviderSnapshot | null = null,
) => {
  const albumIdArray = Array.isArray(albumIdArrayInput) ? albumIdArrayInput : [];
  const statuses: Record<string, AlbumDownloadStatus> = {};
  const { lidarrClient } = await import("../../../services/lidarrClient.ts");

  if (lidarrClient.isConfigured()) {
    try {
      const { queue, history, commands } = snapshot || (await getLidarrStatusSnapshot()).provider;
      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      const historyItems = Array.isArray(history) ? history : history.records || [];
      const searchContext = parseLidarrSearchContext({
        queue,
        history,
        commands,
      });
      const { searchingAlbumIds } = searchContext;

      const latestHistoryByAlbumId = new Map();
      for (const h of historyItems) {
        if (h?.albumId == null) continue;
        const event = classifyLidarrDownloadEvent(h?.eventType);
        if (!event) continue;
        const historyTime = new Date(h?.date || 0).getTime();
        const existing = latestHistoryByAlbumId.get(h.albumId);
        if (!existing || historyTime > existing.historyTime) {
          latestHistoryByAlbumId.set(h.albumId, { event, historyTime });
        }
      }

      const queueByAlbumId = new Map();
      for (const q of queueItems) {
        const qAlbumId = q?.albumId ?? q?.album?.id;
        if (qAlbumId == null) continue;
        queueByAlbumId.set(qAlbumId, q);
      }

      let verifiedAlbumsPromise;
      const getVerifiedAlbums = () =>
        (verifiedAlbumsPromise ??= lidarrClient
          .getAllAlbums()
          .then((albums) => new Map(albums.map((album) => [String(album.id), album])))
          .catch(() => new Map()));

      for (const albumId of albumIdArray) {
        if (!albumId || albumId === "undefined" || albumId === "null") continue;
        const lidarrAlbumId = parseInt(albumId, 10);
        if (isNaN(lidarrAlbumId)) continue;
        const updatedAt = new Date().toISOString();

        const queueItem = queueByAlbumId.get(lidarrAlbumId);
        if (queueItem) {
          statuses[albumId] = { ...readLidarrQueueItemStatus(queueItem), updatedAt };
          continue;
        }

        if (searchingAlbumIds.has(lidarrAlbumId)) {
          statuses[albumId] = { status: "searching", updatedAt };
          continue;
        }

        const historyEntry = latestHistoryByAlbumId.get(lidarrAlbumId);
        if (historyEntry) {
          const staleGrab =
            historyEntry.event === "grabbed" &&
            Date.now() - historyEntry.historyTime > STALE_GRABBED_MS;
          if (historyEntry.event === "imported") {
            statuses[albumId] = { status: "added", updatedAt };
          } else if (historyEntry.event === "failed" || staleGrab) {
            const album = (await getVerifiedAlbums()).get(String(lidarrAlbumId));
            statuses[albumId] = {
              status: albumHasTrackFiles(album) ? "added" : "failed",
              updatedAt,
            };
          } else {
            statuses[albumId] = { status: "processing", updatedAt };
          }
          continue;
        }

        const searchOutcome = resolveAlbumSearchOutcome(lidarrAlbumId, searchContext);
        if (searchOutcome?.status === "failed") {
          statuses[albumId] = {
            status: "failed",
            updatedAt: new Date().toISOString(),
          };
        } else if (searchOutcome?.status === "searching") {
          statuses[albumId] = {
            status: "searching",
            updatedAt: new Date().toISOString(),
          };
        }
      }
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("downloads", "Failed to fetch Lidarr status:", { message: failure?.message });
    }
  }

  return statuses;
};

const computeLidarrStatusSnapshot = async () => {
  const { lidarrClient } = await import("../../../services/lidarrClient.ts");

  if (!lidarrClient.isConfigured()) {
    return { provider: { queue: [], history: { records: [] }, commands: [] }, statuses: {} };
  }

  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue({ forceRefresh: true }),
    lidarrClient.getHistory(1, 200, "date", "descending", { forceRefresh: true }),
    lidarrClient.request<LidarrCommand[] | LidarrPage<LidarrCommand>>(
      "/command",
      "GET",
      null,
      false,
      { forceRefresh: true },
    ),
  ]);
  const provider: LidarrProviderSnapshot = { queue, history, commands };
  const queueItems = Array.isArray(provider.queue) ? provider.queue : provider.queue.records || [];
  const historyItems = Array.isArray(history) ? history : history.records || [];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const albumIds = new Set();
  const searchContext = parseLidarrSearchContext({ queue, history, commands });

  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId != null) albumIds.add(String(albumId));
  }
  for (const item of historyItems) {
    if (item?.albumId == null) continue;
    const historyTime = new Date(item?.date || item?.eventDate || 0).getTime();
    if (historyTime > oneHourAgo) albumIds.add(String(item.albumId));
  }
  for (const albumId of searchContext.searchingAlbumIds) {
    albumIds.add(String(albumId));
  }

  const statuses = await getDownloadStatusesForAlbumIds([...albumIds], provider);
  return { provider, statuses };
};

export const invalidateAllDownloadStatusesCache = () => {
  allDownloadStatusesCache.revision += 1;
  allDownloadStatusesCache.nextRefreshAt = 0;
};

export const hasActiveLidarrStatusSnapshot = () =>
  allDownloadStatusesCache.snapshot?.active === true;

const staleSnapshot = (error: unknown): LidarrStatusSnapshot => ({
  ...(allDownloadStatusesCache.snapshot || {
    provider: { queue: [], history: { records: [] }, commands: [] },
    statuses: {},
    updatedAt: null,
    active: false,
  }),
  stale: true,
  error: asAppError(error)?.message || String(error),
});

export const getLidarrStatusSnapshot = async ({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<LidarrStatusSnapshot> => {
  const { lidarrClient } = await import("../../../services/lidarrClient.ts");
  if (lidarrClient.isCircuitOpen()) {
    return staleSnapshot("Lidarr circuit is open");
  }

  const now = Date.now();
  const maxAgeMs = refresh ? ACTIVE_STATUS_CACHE_MS : Infinity;
  if (
    allDownloadStatusesCache.snapshot &&
    now < allDownloadStatusesCache.nextRefreshAt &&
    now - allDownloadStatusesCache.checkedAt < maxAgeMs
  ) {
    return allDownloadStatusesCache.snapshot;
  }
  if (allDownloadStatusesCache.pending) {
    return allDownloadStatusesCache.pending;
  }

  const refreshRevision = allDownloadStatusesCache.revision;
  allDownloadStatusesCache.pending = computeLidarrStatusSnapshot()
    .then(({ provider, statuses }) => {
      const active = snapshotHasActiveWork(statuses);
      const refreshedAt = Date.now();
      const snapshot = {
        provider,
        statuses,
        updatedAt: new Date(refreshedAt).toISOString(),
        active,
        stale: false,
        error: null,
      };
      allDownloadStatusesCache.snapshot = snapshot;
      allDownloadStatusesCache.checkedAt = refreshedAt;
      allDownloadStatusesCache.failures = 0;
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision
          ? refreshedAt + (active ? ACTIVE_STATUS_CACHE_MS : IDLE_STATUS_CACHE_MS)
          : 0;
      return snapshot;
    })
    .catch((error) => {
      allDownloadStatusesCache.failures += 1;
      allDownloadStatusesCache.checkedAt = Date.now();
      const retryAt =
        allDownloadStatusesCache.checkedAt +
        Math.min(
          MAX_STATUS_RETRY_MS,
          ACTIVE_STATUS_CACHE_MS * 2 ** (allDownloadStatusesCache.failures - 1),
        );
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision ? retryAt : 0;
      logger.warn("downloads", "Failed to refresh Lidarr status:", {
        message: asAppError(error)?.message,
      });
      const snapshot = staleSnapshot(error);
      allDownloadStatusesCache.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      allDownloadStatusesCache.pending = null;
    });

  return allDownloadStatusesCache.pending;
};

export const getAllDownloadStatuses = async () => (await getLidarrStatusSnapshot()).statuses;

const ACTIVE_LIDARR_ALBUM_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

const getActiveLidarrAlbums = async () => {
  const { lidarrClient } = await import("../../../services/lidarrClient.ts");
  if (!lidarrClient.isConfigured()) return [];
  const { statuses } = await getLidarrStatusSnapshot();
  const activeIds = new Set(
    Object.entries(statuses || {})
      .filter(([, entry]) => ACTIVE_LIDARR_ALBUM_STATUSES.has(entry?.status))
      .map(([albumId]) => String(albumId)),
  );
  if (activeIds.size === 0) return [];
  const albums = await lidarrClient.getAllAlbums();
  return albums.filter((album) => activeIds.has(String(album?.id)));
};

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
  canonicalTrackId: v.optional(v.nullable(id)),
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
          canonicalTrackId: body.canonicalTrackId,
          user: c.var.user,
        });
        if (isFailure(result)) {
          return c.json(
            { error: result.error },
            isErrorStatus(result.statusCode) ? result.statusCode : 400,
          );
        }
        if (result.alreadyOwned) return c.json({ success: true, ...result }, 200);
        if (!result.reused) await invalidateActivityRequestsCache();
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

        const { lidarrClient } = await import("../../../services/lidarrClient.ts");
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

        if (searchOnAdd) {
          await lidarrClient.request("/command", "POST", {
            name: "AlbumSearch",
            albumIds: [Number.parseInt(String(albumId), 10)],
          });
          if (artist?.id) {
            await libraryManager.ensureRequestedAlbumMonitoring(artist.id, albumId);
            libraryManager.scheduleRequestedAlbumMonitoringRepair(artist.id, albumId);
          }
        }
        invalidateAllDownloadStatusesCache();

        const { recordAlbumRequested } = await import("../../../services/aurralHistoryService.ts");
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

        const { lidarrClient } = await import("../../../services/lidarrClient.ts");
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

        await lidarrClient.request("/command", "POST", {
          name: "AlbumSearch",
          albumIds: [Number.parseInt(String(albumId), 10)],
        });
        if (album.artistId) {
          await libraryManager.ensureRequestedAlbumMonitoring(album.artistId, albumId);
          libraryManager.scheduleRequestedAlbumMonitoringRepair(album.artistId, albumId);
        }
        invalidateAllDownloadStatusesCache();

        const { recordAlbumSearchStarted } =
          await import("../../../services/aurralHistoryService.ts");
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
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      if (!lidarrClient.isConfigured()) return c.json([], 200);
      const queue = (await getLidarrStatusSnapshot()).provider.queue;
      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      return c.json(
        queueItems.map((item) => ({
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
        if (status?.error === undefined) statuses[key] = status;
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
