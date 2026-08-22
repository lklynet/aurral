import { libraryManager } from "../../../services/libraryManager.js";
import { dbOps } from "../../../db/helpers/index.js";
import { noCache } from "../../../middleware/cache.js";
import { requireAuth, requirePermission } from "../../../middleware/requirePermission.js";
import {
  parseLidarrSearchContext,
  resolveAlbumSearchOutcome,
  albumHasTrackFiles,
} from "../../../services/albumSearchState.js";
import { logger } from "../../../services/logger.js";
import { getCanonicalTrackOwnership } from "../../../services/libraryQueryService.js";

const STALE_GRABBED_MS = 15 * 60 * 1000;
const ACTIVE_STATUS_CACHE_MS = 10 * 1000;
const IDLE_STATUS_CACHE_MS = 60 * 1000;
const MAX_STATUS_RETRY_MS = 2 * 60 * 1000;
let allDownloadStatusesCache = {
  snapshot: null,
  pending: null,
  failures: 0,
  nextRefreshAt: 0,
  revision: 0,
};

const activeDownloadStatuses = new Set(["searching", "downloading", "processing"]);

const snapshotHasActiveWork = (statuses) =>
  Object.values(statuses || {}).some((status) => activeDownloadStatuses.has(status?.status));

const invalidateActivityRequestsCache = () =>
  import("../../requests.js")
    .then(({ invalidateRequestsCache }) => invalidateRequestsCache())
    .catch(() => {});

export const getDownloadStatusesForAlbumIds = async (
  albumIdArrayInput,
  snapshot = null,
) => {
  const albumIdArray = Array.isArray(albumIdArrayInput) ? albumIdArrayInput : [];
  const statuses = {};
  const { lidarrClient } = await import("../../../services/lidarrClient.js");

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
        const historyTime = new Date(h?.date || h?.eventDate || 0).getTime();
        const existing = latestHistoryByAlbumId.get(h.albumId);
        if (!existing || historyTime > existing.historyTime) {
          latestHistoryByAlbumId.set(h.albumId, {
            history: h,
            historyTime,
          });
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

        const queueItem = queueByAlbumId.get(lidarrAlbumId);

        if (queueItem) {
          const queueStatus = String(queueItem.status || "").toLowerCase();
          const title = String(queueItem.title || "").toLowerCase();
          const trackedDownloadState = String(queueItem.trackedDownloadState || "").toLowerCase();
          const trackedDownloadStatus = String(queueItem.trackedDownloadStatus || "").toLowerCase();
          const errorMessage = String(queueItem.errorMessage || "").toLowerCase();
          const statusMessages = Array.isArray(queueItem.statusMessages)
            ? queueItem.statusMessages.map((m) => String(m || "").toLowerCase()).join(" ")
            : "";

          const size = Number(queueItem.size || 0);
          const sizeLeft = Number(queueItem.sizeleft || 0);
          const hasActiveDownload = size > 0 && sizeLeft < size;
          const isDownloadingState =
            hasActiveDownload ||
            queueStatus.includes("downloading") ||
            queueStatus.includes("queued") ||
            queueStatus.includes("processing");
          const isExplicitFailure =
            trackedDownloadState === "importfailed" ||
            trackedDownloadState === "importFailed" ||
            trackedDownloadState.includes("importfailed") ||
            queueStatus.includes("failed") ||
            queueStatus.includes("import fail") ||
            title.includes("import fail") ||
            trackedDownloadState.includes("fail") ||
            trackedDownloadStatus.includes("fail") ||
            (trackedDownloadStatus === "warning" && !isDownloadingState) ||
            errorMessage.includes("fail") ||
            errorMessage.includes("retrying") ||
            statusMessages.includes("unmatched");

          if (isDownloadingState) {
            const progress = size ? Math.round((1 - sizeLeft / size) * 100) : 0;
            statuses[albumId] = {
              status: "downloading",
              progress: progress,
              updatedAt: new Date().toISOString(),
            };
          } else if (isExplicitFailure) {
            statuses[albumId] = {
              status: "failed",
              updatedAt: new Date().toISOString(),
            };
          } else {
            const progress = size ? Math.round((1 - sizeLeft / size) * 100) : 0;
            statuses[albumId] = {
              status: "downloading",
              progress: progress,
              updatedAt: new Date().toISOString(),
            };
          }
          continue;
        }

        if (searchingAlbumIds.has(lidarrAlbumId)) {
          statuses[albumId] = {
            status: "searching",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }

        const historyEntry = latestHistoryByAlbumId.get(lidarrAlbumId);
        const recentHistory = historyEntry?.history;
        const historyTime = historyEntry?.historyTime ?? 0;

        if (recentHistory) {
          const eventType = String(recentHistory.eventType || "").toLowerCase();
          const data = recentHistory?.data || {};
          const statusMessages = Array.isArray(data?.statusMessages)
            ? data.statusMessages.map((m) => String(m || "").toLowerCase()).join(" ")
            : String(data?.statusMessages?.[0] || "").toLowerCase();
          const errorMessage = String(data?.errorMessage || "").toLowerCase();
          const sourceTitle = String(recentHistory?.sourceTitle || "").toLowerCase();
          if (historyEntry.dataString === undefined) {
            historyEntry.dataString = JSON.stringify(data).toLowerCase();
          }
          const dataString = historyEntry.dataString;
          const isGrabbed =
            eventType.includes("grabbed") ||
            sourceTitle.includes("grabbed") ||
            dataString.includes("grabbed");
          const isFailedDownload =
            eventType.includes("fail") ||
            statusMessages.includes("fail") ||
            statusMessages.includes("error") ||
            errorMessage.includes("fail") ||
            errorMessage.includes("error") ||
            sourceTitle.includes("fail") ||
            dataString.includes("fail");
          const isFailedImport =
            eventType === "albumimportincomplete" ||
            eventType.includes("incomplete") ||
            statusMessages.includes("fail") ||
            statusMessages.includes("error") ||
            statusMessages.includes("incomplete") ||
            errorMessage.includes("fail") ||
            errorMessage.includes("error");
          const isComplete =
            eventType.includes("import") &&
            !isFailedImport &&
            eventType !== "albumimportincomplete";
          const isStaleGrabbed = isGrabbed && Date.now() - historyTime > STALE_GRABBED_MS;
          if (isComplete) {
            statuses[albumId] = {
              status: "added",
              updatedAt: new Date().toISOString(),
            };
          } else if (isFailedImport || isFailedDownload || isStaleGrabbed) {
            const album = (await getVerifiedAlbums()).get(String(lidarrAlbumId));
            statuses[albumId] = {
              status: albumHasTrackFiles(album) ? "added" : "failed",
              updatedAt: new Date().toISOString(),
            };
          } else {
            statuses[albumId] = {
              status: "processing",
              updatedAt: new Date().toISOString(),
            };
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
      logger.warn("downloads", "Failed to fetch Lidarr status:", { message: error.message });
    }
  }

  return statuses;
};

const computeLidarrStatusSnapshot = async () => {
  const { lidarrClient } = await import("../../../services/lidarrClient.js");

  if (!lidarrClient.isConfigured()) {
    return { provider: { queue: [], history: { records: [] }, commands: [] }, statuses: {} };
  }

  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue({ forceRefresh: true }),
    lidarrClient.getHistory(1, 200, "date", "descending", { forceRefresh: true }),
    lidarrClient.request("/command", "GET", null, false, { forceRefresh: true }),
  ]);
  const provider = { queue, history, commands };
  const queueItems = Array.isArray(queue) ? queue : queue.records || [];
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

const staleSnapshot = (error) => ({
  ...(allDownloadStatusesCache.snapshot || {
    provider: { queue: [], history: { records: [] }, commands: [] },
    statuses: {},
    updatedAt: null,
    active: false,
  }),
  stale: true,
  error: error?.message || String(error),
});

export const getLidarrStatusSnapshot = async ({ force = false } = {}) => {
  const { lidarrClient } = await import("../../../services/lidarrClient.js");
  if (lidarrClient.isCircuitOpen()) {
    return staleSnapshot("Lidarr circuit is open");
  }

  const now = Date.now();
  if (!force && allDownloadStatusesCache.snapshot && now < allDownloadStatusesCache.nextRefreshAt) {
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
      allDownloadStatusesCache.failures = 0;
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision
          ? refreshedAt + (active ? ACTIVE_STATUS_CACHE_MS : IDLE_STATUS_CACHE_MS)
          : 0;
      return snapshot;
    })
    .catch((error) => {
      allDownloadStatusesCache.failures += 1;
      allDownloadStatusesCache.nextRefreshAt = Date.now() + Math.min(
        MAX_STATUS_RETRY_MS,
        ACTIVE_STATUS_CACHE_MS * 2 ** (allDownloadStatusesCache.failures - 1),
      );
      logger.warn("downloads", "Failed to refresh Lidarr status:", { message: error.message });
      const snapshot = staleSnapshot(error);
      allDownloadStatusesCache.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      allDownloadStatusesCache.pending = null;
    });

  return allDownloadStatusesCache.pending;
};

export const getAllDownloadStatuses = async () =>
  (await getLidarrStatusSnapshot()).statuses;

export function registerDownloads(router) {
  router.post("/downloads/track", requireAuth, requirePermission("addAlbum"), async (req, res) => {
    const body = req.body || {};
    const track = {
      artistName: String(body.artistName || "").trim(),
      trackName: String(body.trackName || "").trim(),
      albumName: String(body.albumName || "").trim() || null,
      artistMbid: String(body.artistMbid || "").trim() || null,
      albumMbid: String(body.albumMbid || "").trim() || null,
      trackMbid: String(body.trackMbid || "").trim() || null,
      releaseYear: String(body.releaseYear || "").trim() || null,
      durationMs: body.durationMs,
      trackNumber: body.trackNumber,
      albumTrackCount: body.albumTrackCount,
      albumTrackTitles: body.albumTrackTitles,
    };
    if (!track.artistName || !track.trackName) {
      return res.status(400).json({ error: "artistName and trackName are required" });
    }

    try {
      const alreadyOwned = getCanonicalTrackOwnership({
        trackMbid: track.trackMbid,
        artistName: track.artistName,
        trackName: track.trackName,
      });
      if (alreadyOwned) return res.json({ success: true, alreadyOwned: true, queued: false });

      const { downloadTracker } = await import(
        "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js"
      );
      const existingJob = downloadTracker.getAll().find((job) => {
        if (job.playlistType !== "library" || ["failed", "done"].includes(job.status)) {
          return false;
        }
        if (track.trackMbid) return job.trackMbid === track.trackMbid;
        return (
          job.artistName?.toLocaleLowerCase() === track.artistName.toLocaleLowerCase() &&
          job.trackName?.toLocaleLowerCase() === track.trackName.toLocaleLowerCase()
        );
      });
      if (existingJob) {
        if (existingJob.status !== "done") {
          const { recordTrackJobQueued } = await import(
            "../../../services/aurralHistoryService.js"
          );
          recordTrackJobQueued(existingJob);
          await invalidateActivityRequestsCache();
        }
        return res.status(202).json({
          success: true,
          queued: existingJob.status !== "done",
          jobId: existingJob.id,
          alreadyQueued: true,
        });
      }

      const jobId = downloadTracker.addJob(track, "library");
      if (!jobId) return res.status(400).json({ error: "Track details are incomplete" });

      const { weeklyFlowWorker } = await import(
        "../../../services/weeklyFlow/weeklyFlowWorker.js"
      );
      try {
        const { normalizeExistingFileMode, reuseTrackForPlaylist } = await import(
          "../../../services/weeklyFlow/weeklyFlowFileReuse.js"
        );
        const reuse = await reuseTrackForPlaylist(track, "library", {
          existingFileMode: normalizeExistingFileMode(
            weeklyFlowWorker.getWorkerSettings().existingFileMode,
          ),
          weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
          existingJobId: jobId,
          targetPlaylistType: "library",
          skipHistory: true,
        });
        if (reuse.reused) {
          return res.status(202).json({
            success: true,
            queued: false,
            reused: true,
            jobId,
          });
        }
      } catch (error) {
        logger.warn("library", "Track reuse failed; leaving acquisition queued", {
          error: error.message,
        });
      }

      const { recordTrackJobQueued } = await import(
        "../../../services/aurralHistoryService.js"
      );
      recordTrackJobQueued(downloadTracker.getJob(jobId));
      await invalidateActivityRequestsCache();
      await weeklyFlowWorker.start();
      return res.status(202).json({ success: true, queued: true, jobId });
    } catch (error) {
      logger.error("library", "Failed to queue track acquisition", error.message);
      return res.status(500).json({
        error: "Failed to queue track acquisition",
        message: error.message,
      });
    }
  });

  router.post("/downloads/album", requireAuth, requirePermission("addAlbum"), async (req, res) => {
    try {
      const { albumId } = req.body;

      if (!albumId) {
        return res.status(400).json({ error: "albumId is required" });
      }

      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      if (!lidarrClient || !lidarrClient.isConfigured()) {
        return res.status(400).json({ error: "Lidarr is not configured" });
      }

      const album = await libraryManager.getAlbumById(albumId);
      if (!album) {
        return res.status(404).json({ error: "Album not found" });
      }

      const artist = album.artistId ? await libraryManager.getArtistById(album.artistId) : null;
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
          albumIds: [parseInt(albumId, 10)],
        });
        await libraryManager.ensureRequestedAlbumMonitoring(artist.id, albumId);
        libraryManager.scheduleRequestedAlbumMonitoringRepair(artist.id, albumId);
      }
      invalidateAllDownloadStatusesCache();

      const { recordAlbumRequested } = await import("../../../services/aurralHistoryService.js");
      recordAlbumRequested({
        albumId,
        albumName: album.albumName,
        artistName: artist?.artistName || album.artistName,
        artistMbid: artist?.mbid || artist?.foreignArtistId,
        searching: searchOnAdd,
        user: req.user,
      });

      res.json({
        success: true,
        message: searchOnAdd ? "Album search triggered" : "Album added to library",
      });
    } catch (error) {
      logger.error("library", "Error initiating album download:", error.message);
      res.status(500).json({
        error: "Failed to initiate album download",
        message: error.message,
      });
    }
  });

  router.post(
    "/downloads/album/search",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      try {
        const { albumId } = req.body;

        if (!albumId) {
          return res.status(400).json({ error: "albumId is required" });
        }

        const { lidarrClient } = await import("../../../services/lidarrClient.js");
        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return res.status(400).json({ error: "Lidarr is not configured" });
        }

        const album = await libraryManager.getAlbumById(albumId);
        if (!album) {
          return res.status(404).json({ error: "Album not found" });
        }

        const artist = album.artistId ? await libraryManager.getArtistById(album.artistId) : null;
        if (artist) {
          await libraryManager.ensureArtistMonitored(artist);
        }

        if (!album.monitored) {
          await libraryManager.updateAlbum(albumId, { monitored: true });
        }

        await lidarrClient.request("/command", "POST", {
          name: "AlbumSearch",
          albumIds: [parseInt(albumId, 10)],
        });
        if (album.artistId) {
          await libraryManager.ensureRequestedAlbumMonitoring(album.artistId, albumId);
          libraryManager.scheduleRequestedAlbumMonitoringRepair(album.artistId, albumId);
        }
        invalidateAllDownloadStatusesCache();

        const { recordAlbumSearchStarted } =
          await import("../../../services/aurralHistoryService.js");
        recordAlbumSearchStarted({
          albumId,
          albumName: album.albumName,
          artistName: artist?.artistName || album.artistName,
          artistMbid: artist?.mbid || artist?.foreignArtistId,
          user: req.user,
        });

        res.json({
          success: true,
          message: "Album search triggered",
        });
      } catch (error) {
        logger.error("downloads", `Failed to trigger album search ${req.body?.albumId}:`, {
          message: error.message,
        });
        res.status(500).json({
          error: "Failed to trigger album search",
          message: error.message,
        });
      }
    },
  );

  router.get("/downloads", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      if (!lidarrClient.isConfigured()) {
        return res.json([]);
      }
      const queue = (await getLidarrStatusSnapshot()).provider.queue;
      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      res.json(
        queueItems.map((item) => ({
          id: item.id,
          type: "album",
          state: item.status || "queued",
          title: item.title,
          artistName: item.artist?.artistName,
          albumTitle: item.album?.title,
          progress: item.size ? Math.round((1 - item.sizeleft / item.size) * 100) : 0,
          source: "lidarr",
        })),
      );
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch downloads",
        message: error.message,
      });
    }
  });

  router.get("/downloads/status", noCache, async (req, res) => {
    try {
      const { albumIds } = req.query;
      if (!albumIds) {
        return res.status(400).json({ error: "albumIds query parameter is required" });
      }
      const albumIdArray = Array.isArray(albumIds) ? albumIds : albumIds.split(",");
      const statuses = await getDownloadStatusesForAlbumIds(albumIdArray);
      res.json(statuses);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch download status",
        message: error.message,
      });
    }
  });

  router.get("/downloads/status/all", noCache, async (req, res) => {
    try {
      const statuses = await getAllDownloadStatuses();
      res.json(statuses);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch download status",
        message: error.message,
      });
    }
  });
}
