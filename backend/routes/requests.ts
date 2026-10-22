import express from "express";
import { UUID_REGEX } from "../../lib/uuid.ts";
import { noCache } from "../middleware/cache.ts";
import { requireAuth, requirePermission } from "../middleware/requirePermission.ts";
import {
  getLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "./library/handlers/downloads.ts";
import type { LidarrRequestItem } from "../services/lidarrRequestBuilder.ts";
import { buildLidarrRequests } from "../services/lidarrRequestBuilder.ts";
import type { LidarrClient, LidarrPage, LidarrQueueItem } from "../services/lidarrClient.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { getAurralHistoryRequests } from "../services/aurralHistoryService.ts";
import { downloadTracker } from "../services/downloadJobs/downloadTracker.ts";

const router = express.Router();
const dismissedAlbumIds = new Map();
const DISMISSED_ALBUM_TTL_MS = 24 * 60 * 60 * 1000;
const REQUESTS_CACHE_MS = 15000;
type AurralRequest = Awaited<ReturnType<typeof getAurralHistoryRequests>>[number];
type RequestsResponse = Awaited<ReturnType<typeof buildRequestsResponse>>;
type RequestsCacheEntry = { response: RequestsResponse; at: number; jobsRevision: number };

const requestsCache = new Map<string | null, RequestsCacheEntry>();
const pendingRequestsRefreshes = new Map();

const getRequestsUserId = (user: RequestUser | null | undefined) =>
  user?.id == null ? null : String(user.id);

const pruneDismissedAlbumIds = () => {
  const now = Date.now();
  for (const [albumId, dismissedAt] of dismissedAlbumIds) {
    if (now - dismissedAt > DISMISSED_ALBUM_TTL_MS) {
      dismissedAlbumIds.delete(albumId);
    }
  }
};

const filterDismissedRequests = <T extends { albumId?: unknown }>(requests: T[]) =>
  Array.isArray(requests)
    ? requests.filter((r) => !r.albumId || !dismissedAlbumIds.has(String(r.albumId)))
    : [];

const updateRequestsCache = (
  requests: RequestsResponse,
  user: RequestUser | null | undefined,
  jobsRevision: number,
) => {
  const response = filterDismissedRequests(requests);
  requestsCache.set(getRequestsUserId(user), { response, at: Date.now(), jobsRevision });
  return response;
};

const removeAlbumFromRequestsCache = (albumId: string) => {
  const normalizedAlbumId = String(albumId);
  for (const cache of requestsCache.values()) {
    if (!cache?.response) continue;
    cache.response = cache.response.filter(
      (request) => String(request?.albumId) !== normalizedAlbumId,
    );
    cache.at = Date.now();
  }
};

const filterRedundantAurralRequests = (
  aurralRequests: AurralRequest[],
  lidarrRequests: (LidarrRequestItem & Partial<Pick<AurralRequest, "requestedBy">>)[],
): AurralRequest[] => {
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

const buildRequestsResponse = async (
  lidarrClient: LidarrClient,
  { refresh = false, user = null }: { refresh?: boolean; user?: RequestUser | null } = {},
) => {
  const snapshot = lidarrClient?.isConfigured() ? await getLidarrStatusSnapshot({ refresh }) : null;
  const [lidarrRequests, aurralRequests] = await Promise.all([
    snapshot ? buildLidarrRequests(lidarrClient, snapshot.provider) : Promise.resolve([]),
    getAurralHistoryRequests(lidarrClient, user),
  ]);
  const filteredAurral = filterRedundantAurralRequests(aurralRequests, lidarrRequests);
  return [...lidarrRequests, ...filteredAurral].sort(
    (a, b) => new Date(b.requestedAt ?? 0).getTime() - new Date(a.requestedAt ?? 0).getTime(),
  );
};

const refreshRequestsCache = async (
  lidarrClient: LidarrClient,
  options: Parameters<typeof buildRequestsResponse>[1],
) => {
  const userId = getRequestsUserId(options?.user);
  if (pendingRequestsRefreshes.has(userId)) return pendingRequestsRefreshes.get(userId);
  const jobsRevision = downloadTracker.getRevision();
  const refresh = buildRequestsResponse(lidarrClient, options)
    .then((requests) => updateRequestsCache(requests, options?.user, jobsRevision))
    .finally(() => {
      pendingRequestsRefreshes.delete(userId);
    });
  pendingRequestsRefreshes.set(userId, refresh);
  return refresh;
};

const removeMatchingQueueItems = async (
  lidarrClient: LidarrClient,
  matches: (item: LidarrQueueItem) => boolean,
) => {
  const queue = await lidarrClient
    .getQueue()
    .catch((): LidarrQueueItem[] | LidarrPage<LidarrQueueItem> => []);
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
    const { lidarrClient } = await import("../services/lidarrClient.ts");
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const userId = getRequestsUserId(req.user);
    const cached = requestsCache.get(userId);

    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.at < REQUESTS_CACHE_MS &&
      cached.jobsRevision === downloadTracker.getRevision()
    ) {
      return res.json(filterDismissedRequests(cached.response));
    }

    const requests = await refreshRequestsCache(lidarrClient, {
      refresh: forceRefresh,
      user: req.user,
    });
    res.json(requests);
  } catch (error) {
    const cached = requestsCache.get(getRequestsUserId(req.user));
    if (cached?.response) {
      return res.json(filterDismissedRequests(cached.response));
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
      const { lidarrClient } = await import("../services/lidarrClient.ts");
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
    const { lidarrClient } = await import("../services/lidarrClient.ts");
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
  requestsCache.clear();
};

export default router;
