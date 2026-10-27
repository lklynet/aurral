import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../lib/uuid.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import {
  getLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "./library/handlers/downloads.ts";
import type { LidarrRequestItem } from "../services/lidarrRequestBuilder.ts";
import { buildLidarrRequests } from "../services/lidarrRequestBuilder.ts";
import type { LidarrClient, LidarrPage, LidarrQueueItem } from "../services/lidarrClient.ts";
import type { AppEnv, RequestUser } from "../middleware/requestUser.ts";
import { getAurralHistoryRequests } from "../services/aurralHistoryService.ts";
import { downloadTracker } from "../services/downloadJobs/downloadTracker.ts";

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

const listQuery = v.object({ refresh: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/requests")
  .get("/", requireAuth, noCache, validate("query", listQuery), async (c) => {
    const user = c.var.user;
    try {
      pruneDismissedAlbumIds();
      const { lidarrClient } = await import("../services/lidarrClient.ts");
      const { refresh } = c.req.valid("query");
      const forceRefresh = refresh === "1" || refresh === "true";
      const cached = requestsCache.get(getRequestsUserId(user));

      if (
        !forceRefresh &&
        cached &&
        Date.now() - cached.at < REQUESTS_CACHE_MS &&
        cached.jobsRevision === downloadTracker.getRevision()
      ) {
        return c.json(filterDismissedRequests(cached.response), 200);
      }

      const requests: RequestsResponse = await refreshRequestsCache(lidarrClient, {
        refresh: forceRefresh,
        user,
      });
      return c.json(requests, 200);
    } catch {
      const cached = requestsCache.get(getRequestsUserId(user));
      if (cached?.response) return c.json(filterDismissedRequests(cached.response), 200);
      return c.json({ error: "Failed to fetch requests" }, 500);
    }
  })
  .delete("/album/:albumId", requireAuth, requirePermission("deleteAlbum"), async (c) => {
    const albumId = c.req.param("albumId");
    dismissedAlbumIds.set(albumId, Date.now());
    pruneDismissedAlbumIds();
    removeAlbumFromRequestsCache(albumId);

    try {
      const { lidarrClient } = await import("../services/lidarrClient.ts");
      if (lidarrClient?.isConfigured()) {
        const targetAlbumId = Number.parseInt(albumId, 10);
        await removeMatchingQueueItems(
          lidarrClient,
          (item) =>
            (item?.albumId != null && item.albumId === targetAlbumId) ||
            (item?.album?.id != null && item.album.id === targetAlbumId),
        );
      }
      invalidateAllDownloadStatusesCache();
      return c.json({ success: true }, 200);
    } catch {
      return c.json({ error: "Failed to remove request" }, 500);
    }
  })
  .delete("/:mbid", requireAuth, requirePermission("deleteArtist"), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);

    try {
      const { lidarrClient } = await import("../services/lidarrClient.ts");
      if (!lidarrClient?.isConfigured()) return c.json({ success: true }, 200);

      const artist = await lidarrClient.getArtistByMbid(mbid).catch(() => null);
      if (!artist?.id) return c.json({ success: true }, 200);

      await removeMatchingQueueItems(
        lidarrClient,
        (item) => (item?.artist?.id ?? item?.album?.artistId) === artist.id,
      );
      invalidateAllDownloadStatusesCache();
      return c.json({ success: true }, 200);
    } catch {
      return c.json({ error: "Failed to remove request" }, 500);
    }
  });

export const invalidateRequestsCache = () => {
  requestsCache.clear();
};
