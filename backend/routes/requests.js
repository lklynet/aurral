import express from "express";
import { UUID_REGEX } from "../config/constants.js";
import { noCache } from "../middleware/cache.js";
import {
  requireAuth,
  requirePermission,
} from "../middleware/requirePermission.js";
import { invalidateAllDownloadStatusesCache } from "./library/handlers/downloads.js";

const router = express.Router();
const dismissedAlbumIds = new Map();
const DISMISSED_ALBUM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DISMISSED_ALBUMS = 1000;
const REQUESTS_CACHE_MS = 15000;
const REQUESTS_STALE_MS = 5 * 60 * 1000;
const STALE_GRABBED_MS = 15 * 60 * 1000;
let lastRequestsResponse = null;
let lastRequestsAt = 0;
let pendingRequestsRefresh = null;

const pruneDismissedAlbumIds = () => {
  const now = Date.now();
  for (const [albumId, dismissedAt] of dismissedAlbumIds.entries()) {
    if (now - dismissedAt > DISMISSED_ALBUM_TTL_MS) {
      dismissedAlbumIds.delete(albumId);
    }
  }
  if (dismissedAlbumIds.size <= MAX_DISMISSED_ALBUMS) {
    return;
  }
  const entries = Array.from(dismissedAlbumIds.entries()).sort(
    (a, b) => a[1] - b[1],
  );
  const removeCount = dismissedAlbumIds.size - MAX_DISMISSED_ALBUMS;
  for (let i = 0; i < removeCount; i++) {
    dismissedAlbumIds.delete(entries[i][0]);
  }
};

const toIso = (value) => {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
};

const filterDismissedRequests = (requests) =>
  Array.isArray(requests)
    ? requests.filter(
        (r) => !r.albumId || !dismissedAlbumIds.has(String(r.albumId)),
      )
    : [];

const updateRequestsCache = (requests) => {
  lastRequestsResponse = filterDismissedRequests(requests);
  lastRequestsAt = Date.now();
  return lastRequestsResponse;
};

const removeAlbumFromRequestsCache = (albumId) => {
  if (!lastRequestsResponse) return;
  const normalizedAlbumId = String(albumId);
  lastRequestsResponse = lastRequestsResponse.filter(
    (request) => String(request?.albumId) !== normalizedAlbumId,
  );
  lastRequestsAt = Date.now();
};

const refreshRequestsCache = async (lidarrClient) => {
  if (pendingRequestsRefresh) {
    return pendingRequestsRefresh;
  }

  pendingRequestsRefresh = buildRequestsResponse(lidarrClient)
    .then(updateRequestsCache)
    .finally(() => {
      pendingRequestsRefresh = null;
    });

  return pendingRequestsRefresh;
};

const filterRedundantAurralRequests = (aurralRequests, lidarrRequests) => {
  const lidarrAlbumIds = new Set(
    lidarrRequests
      .map((request) => request.albumId)
      .filter(Boolean)
      .map((albumId) => String(albumId)),
  );
  if (!lidarrAlbumIds.size) return aurralRequests;
  return aurralRequests.filter((request) => {
    if (request.kind !== "album_requested") return true;
    if (!request.albumId) return true;
    return !lidarrAlbumIds.has(String(request.albumId));
  });
};

const buildLidarrRequests = async (lidarrClient) => {
  const [queue, history] = await Promise.all([
    lidarrClient.getQueue().catch(() => []),
    lidarrClient.getHistory(1, 200).catch(() => ({ records: [] })),
  ]);

  const requestsByAlbumId = new Map();

  const queueItems = Array.isArray(queue) ? queue : queue?.records || [];
  const queueByAlbumId = new Map();
  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId == null) continue;
    queueByAlbumId.set(String(albumId), item);
  }

  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId == null) continue;

    const albumName = item?.album?.title || item?.title || "Album";
    const artistName = item?.artist?.artistName || "Artist";

    let artistMbid = null;

    artistMbid = item?.artist?.foreignArtistId || null;

    const queueStatus = String(item.status || "").toLowerCase();
    const title = String(item.title || "").toLowerCase();
    const trackedDownloadState = String(
      item.trackedDownloadState || "",
    ).toLowerCase();
    const trackedDownloadStatus = String(
      item.trackedDownloadStatus || "",
    ).toLowerCase();
    const errorMessage = String(item.errorMessage || "").toLowerCase();
    const statusMessages = Array.isArray(item.statusMessages)
      ? item.statusMessages
          .map((m) => String(m || "").toLowerCase())
          .join(" ")
      : "";

    const isFailed =
      trackedDownloadState === "importfailed" ||
      trackedDownloadState === "importFailed" ||
      queueStatus.includes("fail") ||
      queueStatus.includes("import fail") ||
      title.includes("import fail") ||
      title.includes("downloaded - import fail") ||
      trackedDownloadState.includes("fail") ||
      trackedDownloadStatus.includes("fail") ||
      trackedDownloadStatus === "warning" ||
      errorMessage.includes("fail") ||
      errorMessage.includes("retrying") ||
      statusMessages.includes("fail") ||
      statusMessages.includes("unmatched");

    const status = isFailed ? "failed" : "processing";

    requestsByAlbumId.set(String(albumId), {
      id: `lidarr-queue-${item.id ?? albumId}`,
      source: "lidarr",
      type: "album",
      albumId: String(albumId),
      albumMbid: item?.album?.foreignAlbumId || null,
      albumName,
      artistId: item?.artist?.id != null ? String(item.artist.id) : null,
      artistMbid,
      artistName,
      status,
      statusLabel: isFailed ? "Failed" : "Downloading",
      requestedAt: toIso(item?.added),
      mbid: artistMbid,
      name: albumName,
      image: null,
      inQueue: true,
      canReSearch: isFailed,
    });
  }

  const historyRecords = Array.isArray(history?.records)
    ? history.records
    : Array.isArray(history)
      ? history
      : [];

  const latestHistoryByAlbum = new Map();
  for (const record of historyRecords) {
    const albumId = record?.albumId;
    if (albumId == null) continue;
    const recordTime = new Date(
      record?.date || record?.eventDate || 0,
    ).getTime();
    const existing = latestHistoryByAlbum.get(String(albumId));
    if (!existing || recordTime > existing.recordTime) {
      latestHistoryByAlbum.set(String(albumId), {
        record,
        recordTime,
      });
    }
  }

  for (const [albumId, { record, recordTime }] of latestHistoryByAlbum) {
    const existing = requestsByAlbumId.get(String(albumId));
    if (existing) continue;

    const albumName = record?.album?.title || record?.sourceTitle || "Album";
    const artistName = record?.artist?.artistName || "Artist";

    let artistMbid = null;

    artistMbid = record?.artist?.foreignArtistId || null;

    const eventType = String(record?.eventType || "").toLowerCase();
    const data = record?.data || {};
    const statusMessages = Array.isArray(data?.statusMessages)
      ? data.statusMessages
          .map((m) => String(m || "").toLowerCase())
          .join(" ")
      : String(data?.statusMessages?.[0] || "").toLowerCase();
    const errorMessage = String(data?.errorMessage || "").toLowerCase();
    const sourceTitle = String(record?.sourceTitle || "").toLowerCase();
    const dataString = JSON.stringify(data).toLowerCase();
    const hasQueue = queueByAlbumId.has(String(albumId));
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
      statusMessages.includes("import fail") ||
      statusMessages.includes("incomplete") ||
      errorMessage.includes("fail") ||
      errorMessage.includes("error") ||
      sourceTitle.includes("import fail") ||
      dataString.includes("import fail");

    const isSuccessfulImport =
      eventType.includes("import") &&
      !isFailedImport &&
      eventType !== "albumimportincomplete";
    const isStaleGrabbed =
      isGrabbed && !hasQueue && Date.now() - recordTime > STALE_GRABBED_MS;
    const status = hasQueue
      ? "processing"
      : isSuccessfulImport
        ? "available"
        : isFailedImport || isFailedDownload || isStaleGrabbed
          ? "failed"
          : isGrabbed
            ? "processing"
            : "processing";
    const statusLabel =
      status === "available"
        ? "Complete"
        : status === "failed"
          ? "Failed"
          : isGrabbed
            ? "Downloading"
            : "In progress";

    requestsByAlbumId.set(String(albumId), {
      id: `lidarr-history-${record.id ?? albumId}`,
      source: "lidarr",
      type: "album",
      albumId: String(albumId),
      albumMbid: record?.album?.foreignAlbumId || null,
      albumName,
      artistId: record?.artistId != null ? String(record.artistId) : null,
      artistMbid,
      artistName,
      status,
      statusLabel,
      requestedAt: toIso(record?.date || record?.eventDate),
      mbid: artistMbid,
      name: albumName,
      image: null,
      inQueue: false,
      canReSearch: status === "failed",
    });
  }

  let sorted = [...requestsByAlbumId.values()].sort(
    (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt),
  );

  const isPlaceholder = (value, fallback) => {
    if (!value) return true;
    const normalized = String(value).trim().toLowerCase();
    return normalized === String(fallback).trim().toLowerCase();
  };

  const missingAlbumIds = new Set();
  const missingArtistIds = new Set();

  for (const request of sorted) {
    if (request.albumId) {
      if (
        !request.albumMbid ||
        isPlaceholder(request.albumName, "Album") ||
        !request.artistId
      ) {
        missingAlbumIds.add(String(request.albumId));
      }
    }
    if (request.artistId) {
      if (
        !request.artistMbid ||
        isPlaceholder(request.artistName, "Artist")
      ) {
        missingArtistIds.add(String(request.artistId));
      }
    }
  }

  const albumDetailsById = new Map();
  const artistDetailsById = new Map();

  if (missingAlbumIds.size > 0) {
    const albumIds = Array.from(missingAlbumIds);
    const albums = await Promise.all(
      albumIds.map((id) => lidarrClient.getAlbum(id).catch(() => null)),
    );
    for (let i = 0; i < albumIds.length; i++) {
      if (albums[i]) {
        albumDetailsById.set(String(albumIds[i]), albums[i]);
        if (albums[i]?.artistId != null) {
          missingArtistIds.add(String(albums[i].artistId));
        }
      }
    }
  }

  if (missingArtistIds.size > 0) {
    const artistIds = Array.from(missingArtistIds);
    const artists = await Promise.all(
      artistIds.map((id) => lidarrClient.getArtist(id).catch(() => null)),
    );
    for (let i = 0; i < artistIds.length; i++) {
      if (artists[i]) {
        artistDetailsById.set(String(artistIds[i]), artists[i]);
      }
    }
  }

  if (albumDetailsById.size > 0 || artistDetailsById.size > 0) {
    sorted = sorted.map((request) => {
      const enriched = { ...request };
      if (
        enriched.albumId &&
        albumDetailsById.has(String(enriched.albumId))
      ) {
        const album = albumDetailsById.get(String(enriched.albumId));
        if (album) {
          if (!enriched.albumMbid && album.foreignAlbumId) {
            enriched.albumMbid = album.foreignAlbumId;
          }
          if (isPlaceholder(enriched.albumName, "Album") && album.title) {
            enriched.albumName = album.title;
            enriched.name = album.title;
          }
          if (!enriched.artistId && album.artistId != null) {
            enriched.artistId = String(album.artistId);
          }
        }
      }
      if (
        enriched.artistId &&
        artistDetailsById.has(String(enriched.artistId))
      ) {
        const artist = artistDetailsById.get(String(enriched.artistId));
        if (artist) {
          if (
            isPlaceholder(enriched.artistName, "Artist") &&
            artist.artistName
          ) {
            enriched.artistName = artist.artistName;
          }
          if (!enriched.artistMbid && artist.foreignArtistId) {
            enriched.artistMbid = artist.foreignArtistId;
            enriched.mbid = artist.foreignArtistId;
          }
        }
      }
      return enriched;
    });
  }

  return filterDismissedRequests(sorted);
};

const buildAurralRequests = async (lidarrClient = null) => {
  const { getAurralHistoryRequests } = await import(
    "../services/aurralHistoryService.js"
  );
  return getAurralHistoryRequests(lidarrClient);
};

const buildRequestsResponse = async (lidarrClient) => {
  const [lidarrRequests, aurralRequests] = await Promise.all([
    lidarrClient?.isConfigured()
      ? buildLidarrRequests(lidarrClient)
      : Promise.resolve([]),
    buildAurralRequests(lidarrClient),
  ]);
  const filteredAurral = filterRedundantAurralRequests(
    aurralRequests,
    lidarrRequests,
  );
  return [...lidarrRequests, ...filteredAurral].sort(
    (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt),
  );
};

router.get("/", requireAuth, noCache, async (req, res) => {
  try {
    pruneDismissedAlbumIds();
    const { lidarrClient } = await import("../services/lidarrClient.js");

    if (!lidarrClient?.isConfigured()) {
      const aurralOnly = await buildAurralRequests();
      lastRequestsResponse = aurralOnly;
      lastRequestsAt = Date.now();
      return res.json(aurralOnly);
    }

    const now = Date.now();
    const cacheAge = now - lastRequestsAt;
    if (lastRequestsResponse && cacheAge < REQUESTS_CACHE_MS) {
      return res.json(filterDismissedRequests(lastRequestsResponse));
    }

    if (lastRequestsResponse && cacheAge < REQUESTS_STALE_MS) {
      refreshRequestsCache(lidarrClient).catch(() => null);
      return res.json(filterDismissedRequests(lastRequestsResponse));
    }

    const requests = await refreshRequestsCache(lidarrClient);
    res.json(requests);
  } catch (error) {
    if (lastRequestsResponse) {
      return res.json(filterDismissedRequests(lastRequestsResponse));
    }
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

router.delete(
  "/album/:albumId",
  requireAuth,
  requirePermission("deleteAlbum"),
  async (req, res) => {
  const { albumId } = req.params;
  if (!albumId) return res.status(400).json({ error: "albumId is required" });

  dismissedAlbumIds.set(String(albumId), Date.now());
  pruneDismissedAlbumIds();
  removeAlbumFromRequestsCache(albumId);

  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    if (lidarrClient?.isConfigured()) {
      const queue = await lidarrClient.getQueue().catch(() => []);
      const queueItems = Array.isArray(queue) ? queue : queue?.records || [];
      const targetAlbumId = parseInt(albumId, 10);

      for (const item of queueItems) {
        const match =
          (item?.albumId != null && item.albumId === targetAlbumId) ||
          (item?.album?.id != null && item.album.id === targetAlbumId);
        if (match && item?.id != null) {
          await lidarrClient
            .request(`/queue/${item.id}`, "DELETE")
            .catch(() => null);
        }
      }
    }
    invalidateAllDownloadStatusesCache();

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to remove request" });
  }
  },
);

router.delete(
  "/:mbid",
  requireAuth,
  requirePermission("deleteArtist"),
  async (req, res) => {
  const { mbid } = req.params;
  if (!UUID_REGEX.test(mbid)) {
    return res.status(400).json({ error: "Invalid MBID format" });
  }

  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    if (!lidarrClient?.isConfigured()) {
      return res.json({ success: true });
    }

    const artist = await lidarrClient.getArtistByMbid(mbid).catch(() => null);
    if (!artist?.id) {
      return res.json({ success: true });
    }

    const queue = await lidarrClient.getQueue().catch(() => []);
    const queueItems = Array.isArray(queue) ? queue : queue?.records || [];

    for (const item of queueItems) {
      const itemArtistId = item?.artist?.id ?? item?.album?.artistId;
      if (itemArtistId === artist.id && item?.id != null) {
        await lidarrClient
          .request(`/queue/${item.id}`, "DELETE")
          .catch(() => null);
      }
    }
    invalidateAllDownloadStatusesCache();

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to remove request" });
  }
  },
);

export default router;
