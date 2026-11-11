import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
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

const REQUESTS_CACHE_MS = 15000;
type RequestsResponse = Awaited<ReturnType<typeof buildRequestsResponse>>;
type RequestsCacheEntry = { response: RequestsResponse; at: number; jobsRevision: number };

const requestsCache = new Map<string | null, RequestsCacheEntry>();
const pendingRequestsRefreshes = new Map<string | null, Promise<RequestsResponse>>();

const getRequestsUserId = (user: RequestUser | null | undefined) =>
  user?.id == null ? null : String(user.id);

const updateRequestsCache = (
  requests: RequestsResponse,
  user: RequestUser | null | undefined,
  jobsRevision: number,
) => {
  requestsCache.set(getRequestsUserId(user), { response: requests, at: Date.now(), jobsRevision });
  return requests;
};

const buildRequestsResponse = async (user: RequestUser | null = null) =>
  (await getAurralHistoryRequests(user)).sort(
    (a, b) => new Date(b.requestedAt ?? 0).getTime() - new Date(a.requestedAt ?? 0).getTime(),
  );

const refreshRequestsCache = async (user: RequestUser | null | undefined) => {
  const userId = getRequestsUserId(user);
  const pending = pendingRequestsRefreshes.get(userId);
  if (pending) return pending;
  const jobsRevision = downloadTracker.getRevision();
  const refresh = buildRequestsResponse(user)
    .then((requests) => updateRequestsCache(requests, user, jobsRevision))
    .finally(() => {
      pendingRequestsRefreshes.delete(userId);
    });
  pendingRequestsRefreshes.set(userId, refresh);
  return refresh;
};

const isRefresh = (refresh: string | undefined) => refresh === "1" || refresh === "true";

const loadRequests = async (user: RequestUser | undefined, forceRefresh: boolean) => {
  try {
    const cached = requestsCache.get(getRequestsUserId(user));
    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.at < REQUESTS_CACHE_MS &&
      cached.jobsRevision === downloadTracker.getRevision()
    ) {
      return cached.response;
    }
    return await refreshRequestsCache(user);
  } catch {
    const cached = requestsCache.get(getRequestsUserId(user));
    return cached?.response ?? null;
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
  });

export const invalidateRequestsCache = () => {
  requestsCache.clear();
};
