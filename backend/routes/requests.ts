import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../lib/uuid.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import {
  getLidarrStatusSnapshot,
  invalidateAllDownloadStatusesCache,
} from "../services/lidarrStatusSnapshot.ts";
import type { LidarrRequestItem } from "../services/lidarrRequestBuilder.ts";
import { buildLidarrRequests } from "../services/lidarrRequestBuilder.ts";
import type { LidarrClient, LidarrQueueItem } from "../services/lidarrClient.ts";
import type { AppEnv, RequestUser } from "../middleware/requestUser.ts";
import { getAurralHistoryRequests } from "../services/aurralHistoryRequests.ts";
import { downloadTracker } from "../services/downloadJobs/downloadTracker.ts";
import { hasPermission } from "../services/auth.ts";
import {
  ACTIVITY_VIEW_IDS,
  buildActivityPage,
  isCancelableDownload,
  normalizeActivityStatus,
  type ActivityRequest,
} from "../../lib/activity.ts";
import { lidarrClient } from "../services/lidarrClient.ts";

const dismissedAlbumIds = new Map();
const DISMISSED_ALBUM_TTL_MS = 24 * 60 * 60 * 1000;
const REQUESTS_CACHE_MS = 15000;
type AurralRequest = Awaited<ReturnType<typeof getAurralHistoryRequests>>[number];
type RequestsResponse = Awaited<ReturnType<typeof buildRequestsResponse>>;
type RequestsCacheEntry = { response: RequestsResponse; at: number; jobsRevision: number };

const requestsCache = new Map<string | null, RequestsCacheEntry>();
const pendingRequestsRefreshes = new Map<string | null, Promise<RequestsResponse>>();

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
  const pending = pendingRequestsRefreshes.get(userId);
  if (pending) return pending;
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
  const queue = await lidarrClient.getQueue().catch((): LidarrQueueItem[] => []);
  for (const item of queue) {
    if (matches(item) && item?.id != null) {
      await lidarrClient.request(`/queue/${item.id}`, "DELETE").catch(() => null);
    }
  }
};

const isRefresh = (refresh: string | undefined) => refresh === "1" || refresh === "true";

const loadRequests = async (user: RequestUser | undefined, forceRefresh: boolean) => {
  try {
    pruneDismissedAlbumIds();
    const cached = requestsCache.get(getRequestsUserId(user));
    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.at < REQUESTS_CACHE_MS &&
      cached.jobsRevision === downloadTracker.getRevision()
    ) {
      return filterDismissedRequests(cached.response);
    }
    return await refreshRequestsCache(lidarrClient, { refresh: forceRefresh, user });
  } catch {
    const cached = requestsCache.get(getRequestsUserId(user));
    return cached?.response ? filterDismissedRequests(cached.response) : null;
  }
};

const ACTIVITY_PAGE_SIZE = 25;

const listQuery = v.object({ refresh: v.optional(v.string()) });
const pageQuery = v.object({
  view: v.picklist(ACTIVITY_VIEW_IDS),
  status: v.optional(v.string()),
  limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1))),
  refresh: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/requests")
  .get("/", requireAuth, noCache, validate("query", listQuery), async (c) => {
    const { refresh } = c.req.valid("query");
    const requests = await loadRequests(c.var.user, isRefresh(refresh));
    return requests ? c.json(requests, 200) : c.json({ error: "Failed to fetch requests" }, 500);
  })
  .get("/page", requireAuth, noCache, validate("query", pageQuery), async (c) => {
    const user = c.var.user;
    const { view, status, limit, refresh } = c.req.valid("query");
    const requests: ActivityRequest[] | null = await loadRequests(user, isRefresh(refresh));
    if (!requests) return c.json({ error: "Failed to fetch requests" }, 500);
    const canCancelAny = hasPermission(user, "accessPlaylists");
    const cancelable = requests.filter(
      (request) =>
        isCancelableDownload(request) &&
        (canCancelAny || (user != null && String(request.requestedBy?.id) === String(user.id))),
    ).length;
    const page = buildActivityPage(requests, {
      view,
      status: normalizeActivityStatus(view, status),
      limit: limit ?? ACTIVITY_PAGE_SIZE,
    });
    return c.json({ ...page, cancelable }, 200);
  })
  .delete("/album/:albumId", requireAuth, requirePermission("deleteAlbum"), async (c) => {
    const albumId = c.req.param("albumId");
    dismissedAlbumIds.set(albumId, Date.now());
    pruneDismissedAlbumIds();
    removeAlbumFromRequestsCache(albumId);

    try {
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
