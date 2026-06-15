import { libraryManager } from "../../../services/libraryManager.js";
import { dbOps } from "../../../config/db-helpers.js";
import { noCache } from "../../../middleware/cache.js";
import {
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.js";
import { hasPermission } from "../../../middleware/auth.js";
import {
  parseLidarrSearchContext,
  resolveAlbumSearchOutcome,
} from "../../../services/albumSearchState.js";

const STALE_GRABBED_MS = 15 * 60 * 1000;
const DOWNLOAD_STATUS_CACHE_MS = 5000;
let allDownloadStatusesCache = {
  at: 0,
  statuses: null,
  pending: null,
};

export const getDownloadStatusesForAlbumIds = async (albumIdArrayInput) => {
  const albumIdArray = Array.isArray(albumIdArrayInput)
    ? albumIdArrayInput
    : [];
  const statuses = {};
  const { lidarrClient } = await import("../../../services/lidarrClient.js");

  if (lidarrClient.isConfigured()) {
    try {
      const [queue, history, commands] = await Promise.all([
        lidarrClient.getQueue(),
        lidarrClient.getHistory(1, 200),
        lidarrClient.request("/command").catch(() => []),
      ]);
      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      const historyItems = Array.isArray(history)
        ? history
        : history.records || [];
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

      for (const albumId of albumIdArray) {
        if (!albumId || albumId === "undefined" || albumId === "null") continue;
        const lidarrAlbumId = parseInt(albumId, 10);
        if (isNaN(lidarrAlbumId)) continue;

        const queueItem = queueItems.find((q) => {
          const qAlbumId = q?.albumId ?? q?.album?.id;
          return qAlbumId != null && qAlbumId === lidarrAlbumId;
        });

        if (queueItem) {
          const queueStatus = String(queueItem.status || "").toLowerCase();
          const title = String(queueItem.title || "").toLowerCase();
          const trackedDownloadState = String(
            queueItem.trackedDownloadState || "",
          ).toLowerCase();
          const trackedDownloadStatus = String(
            queueItem.trackedDownloadStatus || "",
          ).toLowerCase();
          const errorMessage = String(
            queueItem.errorMessage || "",
          ).toLowerCase();
          const statusMessages = Array.isArray(queueItem.statusMessages)
            ? queueItem.statusMessages
                .map((m) => String(m || "").toLowerCase())
                .join(" ")
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
            ? data.statusMessages
                .map((m) => String(m || "").toLowerCase())
                .join(" ")
            : String(data?.statusMessages?.[0] || "").toLowerCase();
          const errorMessage = String(data?.errorMessage || "").toLowerCase();
          const sourceTitle = String(
            recentHistory?.sourceTitle || "",
          ).toLowerCase();
          const dataString = JSON.stringify(data).toLowerCase();
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
          const isStaleGrabbed =
            isGrabbed && Date.now() - historyTime > STALE_GRABBED_MS;
          statuses[albumId] = {
            status: isComplete
              ? "added"
              : isFailedImport || isFailedDownload || isStaleGrabbed
                ? "failed"
                : "processing",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }

        const searchOutcome = resolveAlbumSearchOutcome(
          lidarrAlbumId,
          searchContext,
        );
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
      console.warn("Failed to fetch Lidarr status:", error.message);
    }
  }

  return statuses;
};

const computeAllDownloadStatuses = async () => {
  const allStatuses = {};
  const { lidarrClient } = await import("../../../services/lidarrClient.js");

  if (lidarrClient.isConfigured()) {
    try {
      const [queue, history, albums, commands] = await Promise.all([
        lidarrClient.getQueue(),
        lidarrClient.getHistory(1, 200),
        lidarrClient.request("/album"),
        lidarrClient.request("/command").catch(() => []),
      ]);

      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      const historyItems = Array.isArray(history)
        ? history
        : history.records || [];
      const allAlbums = Array.isArray(albums) ? albums : [];
      const commandItems = Array.isArray(commands)
        ? commands
        : commands?.records || [];
      const searchingAlbumIds = new Set();
      for (const command of commandItems) {
        const name = String(command?.name || command?.commandName || "")
          .toLowerCase()
          .trim();
        if (!name.includes("albumsearch")) continue;
        const status = String(command?.status || "")
          .toLowerCase()
          .trim();
        if (
          status === "completed" ||
          status === "failed" ||
          status === "aborted" ||
          status === "canceled" ||
          status === "cancelled"
        ) {
          continue;
        }
        const albumIds = Array.isArray(command?.body?.albumIds)
          ? command.body.albumIds
          : Array.isArray(command?.albumIds)
            ? command.albumIds
            : [];
        for (const id of albumIds) {
          if (id != null) searchingAlbumIds.add(id);
        }
      }

      const queueByAlbumId = new Map();
      for (const q of queueItems) {
        const qAlbumId = q?.albumId ?? q?.album?.id;
        if (qAlbumId == null) continue;
        queueByAlbumId.set(qAlbumId, q);
      }

      const historyByAlbumId = new Map();
      for (const h of historyItems) {
        if (h?.albumId == null) continue;
        const historyTime = new Date(h?.date || h?.eventDate || 0).getTime();
        const existing = historyByAlbumId.get(h.albumId);
        if (!existing || historyTime > existing.historyTime) {
          historyByAlbumId.set(h.albumId, {
            history: h,
            historyTime,
          });
        }
      }

      for (const album of allAlbums) {
        const lidarrAlbumId = album?.id;
        if (lidarrAlbumId == null) continue;
        const queueItem = queueByAlbumId.get(lidarrAlbumId);

        if (queueItem) {
          const queueStatus = String(queueItem.status || "").toLowerCase();
          const title = String(queueItem.title || "").toLowerCase();
          const trackedDownloadState = String(
            queueItem.trackedDownloadState || "",
          ).toLowerCase();
          const trackedDownloadStatus = String(
            queueItem.trackedDownloadStatus || "",
          ).toLowerCase();
          const errorMessage = String(
            queueItem.errorMessage || "",
          ).toLowerCase();
          const statusMessages = Array.isArray(queueItem.statusMessages)
            ? queueItem.statusMessages
                .map((m) => String(m || "").toLowerCase())
                .join(" ")
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
            allStatuses[String(lidarrAlbumId)] = {
              status: "downloading",
              progress: progress,
              updatedAt: new Date().toISOString(),
            };
          } else if (isExplicitFailure) {
            allStatuses[String(lidarrAlbumId)] = {
              status: "failed",
              updatedAt: new Date().toISOString(),
            };
          } else {
            const progress = size ? Math.round((1 - sizeLeft / size) * 100) : 0;
            allStatuses[String(lidarrAlbumId)] = {
              status: "downloading",
              progress: progress,
              updatedAt: new Date().toISOString(),
            };
          }
          continue;
        }

        if (searchingAlbumIds.has(lidarrAlbumId)) {
          allStatuses[String(lidarrAlbumId)] = {
            status: "searching",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }

        const historyEntry = historyByAlbumId.get(lidarrAlbumId);
        const recentHistory = historyEntry?.history;
        const historyTime = historyEntry?.historyTime ?? 0;

        if (recentHistory) {
          const eventType = String(recentHistory.eventType || "").toLowerCase();
          const data = recentHistory?.data || {};
          const statusMessages = Array.isArray(data?.statusMessages)
            ? data.statusMessages
                .map((m) => String(m || "").toLowerCase())
                .join(" ")
            : String(data?.statusMessages?.[0] || "").toLowerCase();
          const errorMessage = String(data?.errorMessage || "").toLowerCase();
          const sourceTitle = String(
            recentHistory?.sourceTitle || "",
          ).toLowerCase();
          const dataString = JSON.stringify(data).toLowerCase();
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
          const isStaleGrabbed =
            isGrabbed && Date.now() - historyTime > STALE_GRABBED_MS;
          const historyDate = new Date(
            recentHistory.date || recentHistory.eventDate || 0,
          );
          const oneHourAgo = Date.now() - 60 * 60 * 1000;

          if (historyDate.getTime() > oneHourAgo) {
            allStatuses[String(lidarrAlbumId)] = {
              status: isComplete
                ? "added"
                : isFailedImport || isFailedDownload || isStaleGrabbed
                  ? "failed"
                  : "processing",
              updatedAt: new Date().toISOString(),
            };
            continue;
          }
        }
      }
    } catch (error) {
      console.warn("Failed to fetch Lidarr status:", error.message);
    }
  }

  return allStatuses;
};

export const invalidateAllDownloadStatusesCache = () => {
  allDownloadStatusesCache.at = 0;
  allDownloadStatusesCache.statuses = null;
  allDownloadStatusesCache.pending = null;
};

export const getAllDownloadStatuses = async () => {
  const now = Date.now();
  if (
    allDownloadStatusesCache.statuses &&
    now - allDownloadStatusesCache.at < DOWNLOAD_STATUS_CACHE_MS
  ) {
    return allDownloadStatusesCache.statuses;
  }

  if (allDownloadStatusesCache.pending) {
    return allDownloadStatusesCache.pending;
  }

  allDownloadStatusesCache.pending = computeAllDownloadStatuses()
    .then((statuses) => {
      allDownloadStatusesCache.statuses = statuses;
      allDownloadStatusesCache.at = Date.now();
      return statuses;
    })
    .finally(() => {
      allDownloadStatusesCache.pending = null;
    });

  return allDownloadStatusesCache.pending;
};

export default function registerDownloads(router) {
  router.post(
    "/downloads/album",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      try {
        const { artistId, albumId, artistMbid, artistName } = req.body;

        if (!albumId) {
          return res.status(400).json({ error: "albumId is required" });
        }

        const { lidarrClient } =
          await import("../../../services/lidarrClient.js");
        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return res.status(400).json({ error: "Lidarr is not configured" });
        }

        const album = await libraryManager.getAlbumById(albumId);
        if (!album) {
          return res.status(404).json({ error: "Album not found" });
        }

        let artist = artistId
          ? await libraryManager.getArtistById(artistId)
          : null;

        if (!artist && artistMbid && artistName) {
          if (!hasPermission(req.user, "addArtist")) {
            return res.status(403).json({
              error: "Forbidden",
              message: "Permission required: addArtist",
            });
          }
          artist = await libraryManager.addArtistWithPreferences(
            artistMbid,
            artistName,
            {
              user: req.user,
              quality: dbOps.getSettings().quality || "standard",
            },
          );
          if (artist?.error) artist = null;
        }

        if (!artist && album.artistId) {
          artist = await libraryManager.getArtistById(album.artistId);
        }

        if (!artist) {
          return res.status(404).json({
            error:
              "Artist not found. Please add the artist to your library first.",
          });
        }

        try {
          artist = await libraryManager.ensureArtistMonitored(artist);
          if (!album.monitored) {
            await libraryManager.updateAlbum(albumId, { monitored: true });
          }

          const settings = dbOps.getSettings();
          const searchOnAdd =
            settings.integrations?.lidarr?.searchOnAdd ?? false;

          if (searchOnAdd) {
            await lidarrClient.request("/command", "POST", {
              name: "AlbumSearch",
              albumIds: [parseInt(albumId, 10)],
            });
            await libraryManager.ensureRequestedAlbumMonitoring(
              artist.id,
              albumId,
            );
            libraryManager.scheduleRequestedAlbumMonitoringRepair(
              artist.id,
              albumId,
            );
          }
          invalidateAllDownloadStatusesCache();

          const { recordAlbumRequested } = await import(
            "../../../services/aurralHistoryService.js"
          );
          recordAlbumRequested({
            albumId,
            albumName: album.albumName,
            artistName: artist?.artistName || album.artistName,
            artistMbid: artist?.mbid || artist?.foreignArtistId,
            searching: searchOnAdd,
          });

          res.json({
            success: true,
            message: searchOnAdd
              ? "Album search triggered"
              : "Album added to library",
          });
        } catch (error) {
          console.error(
            `Failed to trigger album search ${albumId}:`,
            error.message,
          );
          res.status(500).json({
            error: "Failed to trigger album search",
            message: error.message,
          });
        }
      } catch (error) {
        console.error("Error initiating album download:", error);
        res.status(500).json({
          error: "Failed to initiate album download",
          message: error.message,
        });
      }
    },
  );

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

        const { lidarrClient } =
          await import("../../../services/lidarrClient.js");
        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return res.status(400).json({ error: "Lidarr is not configured" });
        }

        const album = await libraryManager.getAlbumById(albumId);
        if (!album) {
          return res.status(404).json({ error: "Album not found" });
        }

        const artist = album.artistId
          ? await libraryManager.getArtistById(album.artistId)
          : null;
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
          await libraryManager.ensureRequestedAlbumMonitoring(
            album.artistId,
            albumId,
          );
          libraryManager.scheduleRequestedAlbumMonitoringRepair(
            album.artistId,
            albumId,
          );
        }
        invalidateAllDownloadStatusesCache();

        const { recordAlbumSearchStarted } = await import(
          "../../../services/aurralHistoryService.js"
        );
        recordAlbumSearchStarted({
          albumId,
          albumName: album.albumName,
          artistName: artist?.artistName || album.artistName,
          artistMbid: artist?.mbid || artist?.foreignArtistId,
        });

        res.json({
          success: true,
          message: "Album search triggered",
        });
      } catch (error) {
        console.error(
          `Failed to trigger album search ${req.body?.albumId}:`,
          error.message,
        );
        res.status(500).json({
          error: "Failed to trigger album search",
          message: error.message,
        });
      }
    },
  );

  router.post("/downloads/track", async (req, res) => {
    res
      .status(400)
      .json({ error: "Track downloads are not supported by Lidarr" });
  });

  router.get("/downloads", async (req, res) => {
    try {
      const { lidarrClient } =
        await import("../../../services/lidarrClient.js");
      if (!lidarrClient.isConfigured()) {
        return res.json([]);
      }
      const queue = await lidarrClient.getQueue();
      const queueItems = Array.isArray(queue) ? queue : queue.records || [];
      res.json(
        queueItems.map((item) => ({
          id: item.id,
          type: "album",
          state: item.status || "queued",
          title: item.title,
          artistName: item.artist?.artistName,
          albumTitle: item.album?.title,
          progress: item.size
            ? Math.round((1 - item.sizeleft / item.size) * 100)
            : 0,
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
        return res
          .status(400)
          .json({ error: "albumIds query parameter is required" });
      }
      const albumIdArray = Array.isArray(albumIds)
        ? albumIds
        : albumIds.split(",");
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
