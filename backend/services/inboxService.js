import { db } from "../config/db-sqlite.js";
import { dbOps, userOps } from "../db/helpers/index.js";
import { getTicketmasterApiKey } from "./apiClients/index.js";
import {
  getCanonicalAlbumsByReleaseDate,
  iterateCanonicalArtistProjection,
} from "./libraryQueryService.js";
import { getNearbyShows } from "./nearbyShowsService.js";
import { getUserDiscovery } from "./discovery/userDiscovery.js";
import { logger } from "./logger.js";
import { getNewsForUser, getNewsPreferences } from "./newsService.js";
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
  withHonkerLock,
} from "./honkerDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_PAST_DAYS = 30;
const RELEASE_FUTURE_DAYS = 90;
const CONTENT_TTL_MS = 30 * DAY_MS;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const INBOX_REFRESH_STATUS_PREFIX = "inboxRefresh:";
const refreshState = new Map();
const refreshInflight = new Map();

const encode = (value) => encodeURIComponent(String(value || ""));

const toTime = (value) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const getInboxPreferences = () => {
  const configured = dbOps.getSettings().inbox || {};
  return {
    releases: configured.releases !== false,
    shows: configured.shows !== false,
    news: configured.news !== false,
    recommendedNews: configured.recommendedNews === true,
    discoveries: configured.discoveries !== false,
  };
};

const getEnabledKinds = (preferences) =>
  Object.entries({
    release: preferences.releases,
    show: preferences.shows,
    news: preferences.news,
    recommendedNews: preferences.recommendedNews,
    discovery: preferences.discoveries,
  })
    .filter(([, enabled]) => enabled)
    .map(([kind]) => kind);

const normalizeUserId = (userId) => {
  const normalized = Number(userId);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
};

const getInboxRefreshStatusKey = (userId) =>
  `${INBOX_REFRESH_STATUS_PREFIX}${normalizeUserId(userId)}`;

const getStoredRefreshStatus = (userId) =>
  dbOps.getJSONSetting(getInboxRefreshStatusKey(userId)) || {
    status: "idle",
    stale: false,
    error: null,
    updatedAt: null,
    lastSuccessAt: null,
    jobId: null,
  };

const setStoredRefreshStatus = (userId, status) => {
  db.transaction(() => {
    dbOps.setJSONSetting(getInboxRefreshStatusKey(userId), {
      ...getStoredRefreshStatus(userId),
      ...status,
      updatedAt: Date.now(),
    });
  })();
};

export function getInboxRefreshStatus(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return {
      status: "idle",
      stale: false,
      error: null,
      updatedAt: null,
      lastSuccessAt: null,
      jobId: null,
    };
  }

  const stored = getStoredRefreshStatus(normalizedUserId);
  const job = findActiveHonkerJob(
    "system-task",
    (payload) =>
      payload?.kind === "inbox-refresh" && Number(payload.userId) === normalizedUserId,
    { recoverExpired: false },
  );
  if (job) {
    return {
      ...stored,
      status: job.state === "processing" ? "running" : "queued",
      stale: false,
      error: null,
      jobId: Number(job.id),
    };
  }

  if (refreshInflight.has(normalizedUserId)) {
    return { ...stored, status: "running", stale: false, error: null };
  }

  if (stored.status === "queued" || stored.status === "running") {
    return {
      ...stored,
      status: "stale",
      stale: true,
      error: stored.error || "Inbox refresh job is no longer active",
    };
  }
  return stored;
}

const upsertAll = (items) => {
  for (const item of items) dbOps.upsertInboxItem(item);
};

async function buildReleaseItems(userId, now) {
  const cutoff = now - RELEASE_PAST_DAYS * DAY_MS;
  const horizon = now + RELEASE_FUTURE_DAYS * DAY_MS;
  const rawAlbums = getCanonicalAlbumsByReleaseDate({
    from: new Date(cutoff).toISOString().slice(0, 10),
    to: new Date(horizon).toISOString().slice(0, 10),
    limit: 1000,
  });
  const seen = new Set();

  return rawAlbums
    .map((album) => {
      const releaseMbid = String(album?.foreignAlbumId || "").trim();
      const releaseDate = album?.releaseDate || null;
      const releaseTime = toTime(releaseDate);
      const artistMbid = String(album?.foreignArtistId || album?.artistMbid || "").trim();
      const artistName = String(album?.artistName || "").trim();
      if (
        !releaseMbid ||
        !artistMbid ||
        !artistName ||
        !releaseDate ||
        releaseTime == null ||
        releaseTime < cutoff ||
        releaseTime > horizon
      ) {
        return null;
      }
      const sourceKey = `${artistMbid}:${releaseMbid}`;
      if (seen.has(sourceKey)) return null;
      seen.add(sourceKey);
      return {
        userId,
        kind: "release",
        sourceKey,
        title: String(album?.title || "Upcoming release"),
        subtitle: `${artistName} · ${releaseDate}`,
        href: `/artist/${encode(artistMbid)}/release/${encode(releaseMbid)}`,
        metadata: {
          albumMbid: releaseMbid,
          albumName: String(album?.title || "Upcoming release"),
          artistMbid,
          artistName,
          releaseDate,
          releaseType: album?.albumType?.name || album?.albumType || album?.releaseType || null,
        },
        expiresAt: releaseTime + CONTENT_TTL_MS,
      };
    })
    .filter(Boolean);
}

async function buildDiscoveryItems(userId, now) {
  const result = await getUserDiscovery(userId, 50, 0);
  const recommendations = Array.isArray(result?.body?.recommendations)
    ? result.body.recommendations
    : [];
  const seen = new Set();
  return recommendations
    .map((artist) => {
      const artistMbid = String(artist?.mbid || artist?.foreignArtistId || artist?.id || "").trim();
      const artistName = String(artist?.artistName || artist?.name || "").trim();
      if (!artistMbid || !artistName || seen.has(artistMbid)) return null;
      seen.add(artistMbid);
      const subtitle = String(
        artist?.metaText ||
          artist?.sourceArtist ||
          (artist?.discoveryTier === "deeper" ? "A deeper discovery pick" : "Picked for your profile"),
      ).trim();
      return {
        userId,
        kind: "discovery",
        sourceKey: artistMbid,
        title: artistName,
        subtitle,
        href: `/artist/${encode(artistMbid)}`,
        imageUrl: artist?.image || artist?.imageUrl || null,
        metadata: { artistMbid, artistName },
        expiresAt: now + CONTENT_TTL_MS,
      };
    })
    .filter(Boolean);
}

async function buildShowItems(userId, now, req, ipAddress, zipCode, libraryArtists) {
  const apiKey = getTicketmasterApiKey();
  if (!apiKey || (!req && !ipAddress) || !Array.isArray(libraryArtists) || libraryArtists.length === 0) {
    return [];
  }
  const result = await getNearbyShows({
    req: req || { headers: {}, ip: ipAddress },
    zipCode,
    libraryArtists,
    recommendedArtists: [],
    trendingArtists: [],
    limit: 60,
  });
  const grouped = new Map();
  for (const show of result?.libraryShows || []) {
    const key = String(show?.ticketmasterEventId || show?.id || "").trim();
    if (!key) continue;
    const current = grouped.get(key) || { ...show, artistNames: [] };
    const artistNames = Array.isArray(show.artistNames) ? show.artistNames : [show.artistName];
    for (const artistName of artistNames) {
      if (artistName && !current.artistNames.includes(artistName)) {
        current.artistNames.push(artistName);
      }
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map((show) => {
    const date = show.dateTime || show.date;
    const expiry = toTime(date) || now + RELEASE_FUTURE_DAYS * DAY_MS;
    const artistNames = show.artistNames.join(", ") || show.artistName || "Library artist";
    return {
      userId,
      kind: "show",
      sourceKey: String(show.ticketmasterEventId || show.id),
      title: show.eventName || artistNames,
      subtitle: [artistNames, show.date, show.venueName, show.city].filter(Boolean).join(" · "),
      href: show.url || null,
      imageUrl: show.image || null,
      metadata: { ...show, artistNames },
      expiresAt: expiry + DAY_MS,
    };
  });
}

async function buildNewsItems(userId, now, enabledKinds) {
  const { articles } = await getNewsForUser({ userId, limit: 100 });
  const grouped = new Map();
  for (const article of articles) {
    const kind = article.newsType === "recommended"
      ? "recommendedNews"
      : "news";
    if (!enabledKinds.has(kind)) continue;
    const artistMbid = String(article?.artistMbid || article?.artistName || "").trim();
    const artistName = String(article?.artistName || "").trim();
    if (!artistName) continue;
    const day = String(article?.publishedAt || "").slice(0, 10) || new Date(now).toISOString().slice(0, 10);
    const key = `${kind}:${artistMbid}:${day}`;
    const list = grouped.get(key) || [];
    if (list.length < 5) list.push(article);
    grouped.set(key, list);
  }

  return [...grouped.entries()].map(([key, dailyArticles]) => {
    const first = dailyArticles[0];
    const sources = [...new Set(dailyArticles.map((article) => article.source).filter(Boolean))];
    const kind = first.newsType === "recommended" ? "recommendedNews" : "news";
    return {
      userId,
      kind,
      sourceKey: key,
      title: `${first.artistName} news`,
      subtitle: `${dailyArticles.length} ${dailyArticles.length === 1 ? "story" : "stories"}${sources.length ? ` · ${sources.slice(0, 2).join(", ")}` : ""}`,
      href: first.url,
      imageUrl: first.imageUrl,
      metadata: {
        artistMbid: first.artistMbid,
        artistName: first.artistName,
        newsType: first.newsType,
        articles: dailyArticles,
      },
      expiresAt: now + CONTENT_TTL_MS,
    };
  });
}

const dismissBlockedNewsItems = (userId) => {
  const blocked = new Set(
    getNewsPreferences(userId).blockedPublishers.map((publisher) => publisher.toLowerCase()),
  );
  if (blocked.size === 0) return;
  for (const item of dbOps.getInboxItems(userId, {
    kinds: ["news", "recommendedNews"],
    limit: 50,
  })) {
    const articles = Array.isArray(item.metadata?.articles) ? item.metadata.articles : [];
    if (
      articles.length > 0 &&
      articles.every((article) => blocked.has(String(article?.source || "").trim().toLowerCase()))
    ) {
      dbOps.updateInboxItem(userId, item.id, { isDismissed: true });
    }
  }
};

export async function refreshInboxForUser(
  userId,
  {
    req = null,
    ipAddress = "",
    zipCode = "",
    force = false,
    throwOnFailure = false,
    jobId = null,
  } = {},
) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return false;
  const state = refreshState.get(normalizedUserId);
  const hasLocationRequest = Boolean(req || ipAddress);
  if (
    !force &&
    state &&
    Date.now() - state.at < REFRESH_COOLDOWN_MS &&
    (!hasLocationRequest || state.hadLocationRequest)
  ) {
    return false;
  }
  if (refreshInflight.has(normalizedUserId)) return refreshInflight.get(normalizedUserId);

  const promise = (async () => {
    const now = Date.now();
    setStoredRefreshStatus(normalizedUserId, {
      status: "running",
      stale: false,
      error: null,
      ...(jobId ? { jobId } : {}),
    });
    const preferences = getInboxPreferences();
    const libraryArtists = preferences.shows
      ? [...iterateCanonicalArtistProjection({ pageSize: 100 })]
      : [];
    const enabledNewsKinds = new Set(
      getEnabledKinds(preferences).filter((kind) =>
        ["news", "recommendedNews"].includes(kind),
      ),
    );
    const results = await Promise.allSettled([
      preferences.releases ? buildReleaseItems(normalizedUserId, now) : [],
      preferences.discoveries ? buildDiscoveryItems(normalizedUserId, now) : [],
      preferences.shows
        ? buildShowItems(normalizedUserId, now, req, ipAddress, zipCode, libraryArtists)
        : [],
      enabledNewsKinds.size > 0 ? buildNewsItems(normalizedUserId, now, enabledNewsKinds) : [],
    ]);
    const sourceNames = ["releases", "discoveries", "shows", "news"];
    const failures = results
      .map((result, index) => ({ result, source: sourceNames[index] }))
      .filter(({ result }) => result.status === "rejected");
    for (const { result, source } of failures) {
      logger.warn("inbox", "Inbox source refresh failed", {
        source,
        error: result.reason?.message,
      });
    }
    const items = results
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value);
    db.transaction(() => {
      upsertAll(items);
      dismissBlockedNewsItems(normalizedUserId);
    })();
    refreshState.set(normalizedUserId, { at: now, hadLocationRequest: hasLocationRequest });
    const refreshStatus = failures.length === 0
      ? "complete"
      : failures.length === results.length
        ? "failed"
        : "stale";
    const errorMessage = failures.length > 0
      ? failures.map(({ result, source }) => `${source}: ${result.reason?.message || "failed"}`).join("; ")
      : null;
    setStoredRefreshStatus(normalizedUserId, {
      status: refreshStatus,
      stale: failures.length > 0,
      error: errorMessage,
      ...(jobId ? { jobId } : {}),
      ...(failures.length === 0 ? { lastSuccessAt: now } : {}),
    });
    if (failures.length > 0 && throwOnFailure) {
      const error = new Error(errorMessage);
      error.inboxStatusWritten = true;
      throw error;
    }
    return failures.length === 0;
  })().catch((error) => {
    logger.warn("inbox", "Inbox refresh failed", { userId: normalizedUserId, error: error.message });
    refreshState.set(normalizedUserId, { at: Date.now(), hadLocationRequest: hasLocationRequest });
    if (!error.inboxStatusWritten) {
      setStoredRefreshStatus(normalizedUserId, {
        status: "failed",
        stale: true,
        error: error.message,
        ...(jobId ? { jobId } : {}),
      });
    }
    if (throwOnFailure) throw error;
    return false;
  }).finally(() => {
    refreshInflight.delete(normalizedUserId);
  });

  refreshInflight.set(normalizedUserId, promise);
  return promise;
}

export async function enqueueInboxRefreshForUser(
  userId,
  { reason = "manual", zipCode = "", ipAddress = "" } = {},
) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) throw new Error("A valid user is required");
  return withHonkerLock(`inbox-refresh:${normalizedUserId}`, async () => {
    const existing = findActiveHonkerJob(
      "system-task",
      (payload) =>
        payload?.kind === "inbox-refresh" && Number(payload.userId) === normalizedUserId,
      { recoverExpired: true },
    );
    if (existing) {
      return {
        queued: false,
        jobId: Number(existing.id),
        status: existing.state === "processing" ? "running" : "queued",
      };
    }

    const jobId = enqueueSystemTaskJob({
      kind: "inbox-refresh",
      userId: normalizedUserId,
      reason: String(reason || "manual"),
      zipCode: String(zipCode || "").trim(),
      ipAddress: String(ipAddress || "").trim(),
    }, { priority: reason === "manual" ? 5 : 0 });
    setStoredRefreshStatus(normalizedUserId, {
      status: "queued",
      stale: false,
      error: null,
      reason,
      jobId: Number(jobId),
    });
    return { queued: true, jobId: Number(jobId), status: "queued" };
  });
}

export async function enqueueInboxRefreshForAllUsers(options = {}) {
  const jobs = [];
  for (const user of userOps.getAllUsers()) {
    jobs.push(await enqueueInboxRefreshForUser(user.id, options));
  }
  return jobs;
}

export async function refreshInboxForAllUsers(options = {}) {
  return enqueueInboxRefreshForAllUsers({ reason: "scheduled", ...options });
}

export function getInboxForUser(userId, options = {}) {
  const kinds = getEnabledKinds(getInboxPreferences());
  const refreshStatus = getInboxRefreshStatus(userId);
  if (kinds.length === 0) {
    return {
      items: [],
      unreadCount: 0,
      refreshing: refreshStatus.status === "queued" || refreshStatus.status === "running",
      refreshStatus,
    };
  }
  return {
    items: dbOps.getInboxItems(userId, { limit: options.limit || 50, kinds }),
    unreadCount: dbOps.getInboxUnreadCount(userId, kinds),
    refreshing: refreshStatus.status === "queued" || refreshStatus.status === "running",
    refreshStatus,
  };
}

export const updateInboxItem = (userId, itemId, updates) =>
  dbOps.updateInboxItem(userId, itemId, updates);

export const markAllInboxItemsRead = (userId) => {
  dbOps.markAllInboxItemsRead(userId);
  return dbOps.getInboxUnreadCount(userId);
};

export const getInboxRefreshCooldownMs = () => REFRESH_COOLDOWN_MS;
