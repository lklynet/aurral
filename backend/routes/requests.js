import express from "express";
import { UUID_REGEX } from "../../lib/uuid.js";
import { noCache } from "../middleware/cache.js";
import { requireAuth, requirePermission } from "../middleware/requirePermission.js";
import {
  getLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "./library/handlers/downloads.js";
import { buildLidarrRequests } from "../services/lidarrRequestBuilder.js";
import { getAurralHistoryRequests } from "../services/aurralHistoryService.js";

const router = express.Router();
const dismissedAlbumIds = new Map();
const DISMISSED_ALBUM_TTL_MS = 24 * 60 * 60 * 1000;
const REQUESTS_CACHE_MS = 15000;
let lastRequestsResponse = null;
let lastRequestsAt = 0;
let lastRequestsUserId = null;
const pendingRequestsRefreshes = new Map();

const getRequestsUserId = (user) => (user?.id == null ? null : String(user.id));

const pruneDismissedAlbumIds = () => {
  const now = Date.now();
  for (const [albumId, dismissedAt] of dismissedAlbumIds) {
    if (now - dismissedAt > DISMISSED_ALBUM_TTL_MS) {
      dismissedAlbumIds.delete(albumId);
    }
  }
};

const filterDismissedRequests = (requests) =>
  Array.isArray(requests)
    ? requests.filter((r) => !r.albumId || !dismissedAlbumIds.has(String(r.albumId)))
    : [];

const updateRequestsCache = (requests, user) => {
  lastRequestsResponse = filterDismissedRequests(requests);
  lastRequestsAt = Date.now();
  lastRequestsUserId = getRequestsUserId(user);
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

const filterRedundantAurralRequests = (aurralRequests, lidarrRequests) => {
  const lidarrAlbumIds = new Set(
    lidarrRequests
      .map((request) => request.albumId)
      .filter(Boolean)
      .map((albumId) => String(albumId)),
  );
  if (!lidarrAlbumIds.size) return aurralRequests;
  for (const request of aurralRequests) {
    if (request.kind !== "album_requested" || !request.albumId || !request.requestedBy) {
      continue;
    }
    const albumId = String(request.albumId);
    if (!lidarrAlbumIds.has(albumId)) continue;
    for (const lidarrRequest of lidarrRequests) {
      if (String(lidarrRequest.albumId) === albumId) {
        lidarrRequest.requestedBy = request.requestedBy;
      }
    }
  }
  return aurralRequests.filter((request) => {
    if (request.kind !== "album_requested") return true;
    if (!request.albumId) return true;
    return !lidarrAlbumIds.has(String(request.albumId));
  });
};

const buildRequestsResponse = async (lidarrClient, { force = false, user = null } = {}) => {
  const snapshot = lidarrClient?.isConfigured()
    ? await getLidarrStatusSnapshot({ force })
    : null;
  const [lidarrRequests, aurralRequests] = await Promise.all([
    snapshot ? buildLidarrRequests(lidarrClient, snapshot.provider) : Promise.resolve([]),
    getAurralHistoryRequests(lidarrClient, user),
  ]);
  const filteredAurral = filterRedundantAurralRequests(aurralRequests, lidarrRequests);
  return [...lidarrRequests, ...filteredAurral].sort(
    (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt),
  );
};

const refreshRequestsCache = async (lidarrClient, options) => {
  const userId = getRequestsUserId(options?.user);
  if (pendingRequestsRefreshes.has(userId)) return pendingRequestsRefreshes.get(userId);
  const refresh = buildRequestsResponse(lidarrClient, options)
    .then((requests) => updateRequestsCache(requests, options?.user))
    .finally(() => {
      pendingRequestsRefreshes.delete(userId);
    });
  pendingRequestsRefreshes.set(userId, refresh);
  return refresh;
};

const removeMatchingQueueItems = async (lidarrClient, matches) => {
  const queue = await lidarrClient.getQueue().catch(() => []);
  const queueItems = Array.isArray(queue) ? queue : queue?.records || [];
  for (const item of queueItems) {
    if (matches(item) && item?.id != null) {
      await lidarrClient.request(`/queue/${item.id}`, "DELETE").catch(() => null);
    }
  }
};

router.get("/", requireAuth, noCache, async (req, res) => {
  try {
    pruneDismissedAlbumIds();
    const { lidarrClient } = await import("../services/lidarrClient.js");

    if (!lidarrClient?.isConfigured()) {
      const aurralOnly = await getAurralHistoryRequests(null, req.user);
      lastRequestsResponse = filterDismissedRequests(aurralOnly);
      lastRequestsAt = Date.now();
      lastRequestsUserId = getRequestsUserId(req.user);
      return res.json(aurralOnly);
    }

    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    if (
      !forceRefresh &&
      lastRequestsResponse &&
      lastRequestsUserId === getRequestsUserId(req.user) &&
      Date.now() - lastRequestsAt < REQUESTS_CACHE_MS
    ) {
      return res.json(filterDismissedRequests(lastRequestsResponse));
    }

    const requests = await refreshRequestsCache(lidarrClient, {
      force: forceRefresh,
      user: req.user,
    });
    res.json(requests);
  } catch (error) {
    if (lastRequestsResponse && lastRequestsUserId === getRequestsUserId(req.user)) {
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
        const targetAlbumId = parseInt(albumId, 10);
        await removeMatchingQueueItems(
          lidarrClient,
          (item) =>
            (item?.albumId != null && item.albumId === targetAlbumId) ||
            (item?.album?.id != null && item.album.id === targetAlbumId),
        );
      }
      invalidateAllDownloadStatusesCache();
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to remove request" });
    }
  },
);

router.delete("/:mbid", requireAuth, requirePermission("deleteArtist"), async (req, res) => {
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

    await removeMatchingQueueItems(
      lidarrClient,
      (item) => (item?.artist?.id ?? item?.album?.artistId) === artist.id,
    );
    invalidateAllDownloadStatusesCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to remove request" });
  }
});

export const invalidateRequestsCache = () => {
  lastRequestsResponse = null;
  lastRequestsAt = 0;
  lastRequestsUserId = null;
};

export default router;
