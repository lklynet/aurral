import { libraryManager } from "../../../services/libraryManager.js";
import { dbOps } from "../../../db/helpers/index.js";
import { noCache } from "../../../middleware/cache.js";
import { requireAuth, requirePermission } from "../../../middleware/requirePermission.js";
import {
  albumHasTrackFiles,
  classifyLidarrDownloadEvent,
  parseLidarrSearchContext,
  readLidarrQueueItemStatus,
  resolveAlbumSearchOutcome,
} from "../../../services/albumSearchState.js";
import { logger } from "../../../services/logger.js";
import { getLibraryTrackOwnership } from "../../../services/libraryQueryService.js";
import { resolveAurralOwnedTrackJob } from "../../../services/libraryTrackResearchService.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "../../../services/downloadSourceService.js";

const STALE_GRABBED_MS = 15 * 60 * 1000;
const ACTIVE_STATUS_CACHE_MS = 10 * 1000;
const IDLE_STATUS_CACHE_MS = 60 * 1000;
const MAX_STATUS_RETRY_MS = 2 * 60 * 1000;
let allDownloadStatusesCache = {
  snapshot: null,
  pending: null,
  failures: 0,
  checkedAt: 0,
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

function sendLidarrImportError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    logger.error("library", "Failed to import track into Lidarr", error.message);
  }
  return res.status(statusCode).json({
    error: error.message || "Failed to import track into Lidarr",
    ...(error.rejections?.length ? { rejections: error.rejections } : {}),
  });
}

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
        const event = classifyLidarrDownloadEvent(h?.eventType);
        if (!event) continue;
        const historyTime = new Date(h?.date || h?.eventDate || 0).getTime();
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
          const staleGrab = historyEntry.event === "grabbed"
            && Date.now() - historyEntry.historyTime > STALE_GRABBED_MS;
          if (historyEntry.event === "imported") {
            statuses[albumId] = { status: "added", updatedAt };
          } else if (historyEntry.event === "failed" || staleGrab) {
            const album = (await getVerifiedAlbums()).get(String(lidarrAlbumId));
            statuses[albumId] = { status: albumHasTrackFiles(album) ? "added" : "failed", updatedAt };
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

export const getLidarrStatusSnapshot = async ({ refresh = false } = {}) => {
  const { lidarrClient } = await import("../../../services/lidarrClient.js");
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
      const retryAt = allDownloadStatusesCache.checkedAt + Math.min(
        MAX_STATUS_RETRY_MS,
        ACTIVE_STATUS_CACHE_MS * 2 ** (allDownloadStatusesCache.failures - 1),
      );
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision ? retryAt : 0;
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

const ACTIVE_LIBRARY_JOB_STATUSES = new Set(["pending", "downloading"]);
const ACTIVE_LIDARR_ALBUM_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

const getActiveLidarrAlbums = async () => {
  const { lidarrClient } = await import("../../../services/lidarrClient.js");
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
  const albums = new Set();
  const artists = new Set();
  const tracks = [];
  for (const job of downloadTracker.getAll()) {
    if (job.playlistType !== "library" || !ACTIVE_LIBRARY_JOB_STATUSES.has(job.status)) continue;
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
    logger.warn("downloads", "Failed to read active Lidarr downloads", { message: error.message });
  }
  return { albums: [...albums], artists: [...artists], tracks };
};

export function registerDownloads(router) {
  router.post(
    "/downloads/tracks/:trackId/research",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      const trackId = Number(req.params.trackId);
      const albumId = req.body?.albumId;
      const sourceJob = resolveAurralOwnedTrackJob({ trackId, albumId });
      if (!sourceJob) {
        return res.status(404).json({
          error: "Track is not an available Aurral-managed library track",
        });
      }
      if (!isAnyDownloadSourceConfigured()) {
        const message = getDownloadSourceNotConfiguredMessage();
        return res.status(400).json({ error: message, message });
      }
      if (downloadTracker.findActiveUpgradeJob(sourceJob)) {
        return res.status(409).json({ error: "A search for this track is already running" });
      }

      try {
        const result = await playlistOperationQueue.enqueuePayload({
          kind: "library-track-research",
          label: `library-track-research:${trackId}:${albumId || "all"}`,
          trackId,
          albumId,
        });
        return res.status(202).json({
          success: true,
          queued: true,
          operationId: result.operationId,
        });
      } catch (error) {
        logger.error("library", "Failed to queue track replacement search", error.message);
        return res.status(500).json({
          error: "Failed to queue track replacement search",
          message: error.message,
        });
      }
    },
  );

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
      const alreadyOwned = getLibraryTrackOwnership({
        trackMbid: track.trackMbid,
        artistName: track.artistName,
        trackName: track.trackName,
      });
      if (alreadyOwned) return res.json({ success: true, alreadyOwned: true, queued: false });

      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      if (
        dbOps.getSettings().integrations?.lidarr?.importOnAddToLibrary === true &&
        lidarrClient.isConfigured()
      ) {
        const { findFinishedTrackJob, importTrackToLidarr } = await import(
          "../../../services/lidarrTrackImport.js"
        );
        const finishedJob = await findFinishedTrackJob(track);
        if (finishedJob) {
          try {
            const result = await importTrackToLidarr({ jobId: finishedJob.id });
            await invalidateActivityRequestsCache();
            return res.json({
              success: true,
              importedToLidarr: true,
              queued: false,
              jobId: finishedJob.id,
              lidarrAlbumId: result.lidarrAlbumId,
              trackFile: result.trackFile,
            });
          } catch (error) {
            return sendLidarrImportError(res, error);
          }
        }
      }

      const monitoredTrack = await libraryManager.monitorAurralTrack({
        canonicalTrackId: body.canonicalTrackId,
        trackMbid: track.trackMbid,
      });
      if (monitoredTrack) {
        await invalidateActivityRequestsCache();
        return res.status(202).json({
          success: true,
          queued: monitoredTrack.queuedJobIds.length > 0,
          jobId: monitoredTrack.queuedJobIds[0] || null,
          monitored: true,
        });
      }

      const { downloadTracker } = await import(
        "../../../services/downloadJobs/downloadTracker.js"
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

      const { downloadWorker } = await import(
        "../../../services/downloadJobs/downloadWorker.js"
      );
      try {
        const { normalizeExistingFileMode, reuseTrackForPlaylist } = await import(
          "../../../services/downloadJobs/fileReuse.js"
        );
        const reuse = await reuseTrackForPlaylist(track, "library", {
          existingFileMode: normalizeExistingFileMode(
            downloadWorker.getWorkerSettings().existingFileMode,
          ),
          downloadRoot: downloadWorker.downloadRoot,
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
      await downloadWorker.start();
      return res.status(202).json({ success: true, queued: true, jobId });
    } catch (error) {
      logger.error("library", "Failed to queue track acquisition", error.message);
      return res.status(500).json({
        error: "Failed to queue track acquisition",
        message: error.message,
      });
    }
  });

  router.post(
    "/downloads/track/import-to-lidarr",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      const body = req.body || {};
      try {
        const [{ importTrackToLidarr }, { canAccessJobType }] = await Promise.all([
          import("../../../services/lidarrTrackImport.js"),
          import("../../playlists/handlers/utils.js"),
        ]);
        const result = await importTrackToLidarr(
          {
            jobId: body.jobId,
            trackMbid: body.trackMbid,
            artistName: body.artistName,
            trackName: body.trackName,
          },
          { canAccessJob: (job) => canAccessJobType(req.user, job.playlistId || job.playlistType) },
        );
        await invalidateActivityRequestsCache();
        return res.json({
          success: true,
          lidarrAlbumId: result.lidarrAlbumId,
          trackFile: result.trackFile,
          jobsUpdated: result.jobsUpdated,
        });
      } catch (error) {
        return sendLidarrImportError(res, error);
      }
    },
  );

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

      const album = await libraryManager.getAlbumById(albumId, { managedBy: "lidarr" });
      if (!album) {
        return res.status(404).json({ error: "Album not found" });
      }

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

        const album = await libraryManager.getAlbumById(albumId, { managedBy: "lidarr" });
        if (!album) {
          return res.status(404).json({ error: "Album not found" });
        }

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
      const aurralPrefix = "aurral:";
      const aurralIds = albumIdArray.filter((id) => String(id).startsWith(aurralPrefix));
      const statuses = await getDownloadStatusesForAlbumIds(
        albumIdArray.filter((id) => !String(id).startsWith(aurralPrefix)),
      );
      for (const key of aurralIds) {
        const status = libraryManager.getAurralAlbumStatus(key.slice(aurralPrefix.length));
        if (!status?.error) statuses[key] = status;
      }
      res.json(statuses);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch download status",
        message: error.message,
      });
    }
  });

  router.get("/downloads/active", noCache, async (_req, res) => {
    try {
      res.json(await getActiveLibraryDownloads());
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch active downloads",
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
