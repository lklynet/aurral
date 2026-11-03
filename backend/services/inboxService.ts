import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { getTicketmasterApiKey } from "./apiClients/index.ts";
import { getLibraryAlbumsByReleaseDate, getLibraryArtistNames } from "./libraryQueryService.ts";
import { getNearbyShows, getRememberedNearbyLocation } from "./nearbyShowsService.ts";
import { getUserDiscovery } from "./discovery/userDiscovery.ts";
import { logger } from "./logger.ts";
import type { InboxItemInput, InboxItemUpdates } from "../db/helpers/inbox.ts";
import { getNewsForUser } from "./newsService.ts";
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
  getSystemTaskQueueName,
  withHonkerLock,
} from "./honkerDb.ts";
import { albumPath } from "../../lib/albumPath.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_PAST_DAYS = 30;
const RELEASE_FUTURE_DAYS = 90;
const CONTENT_TTL_MS = 30 * DAY_MS;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const INBOX_REFRESH_STATUS_PREFIX = "inboxRefresh:";
const refreshState = new Map<number, { at: number; hadLocation: boolean }>();
const refreshInflight = new Map<number, Promise<boolean>>();

const encode = (value: string) => encodeURIComponent(String(value || ""));

const toTime = (value: string | null | undefined) => {
  const time = new Date(value ?? NaN).getTime();
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

const getEnabledKinds = (preferences: ReturnType<typeof getInboxPreferences>) =>
  Object.entries({
    release: preferences.releases,
    show: preferences.shows,
    news: preferences.news,
    recommendedNews: preferences.recommendedNews,
    discovery: preferences.discoveries,
  })
    .filter(([, enabled]) => enabled)
    .map(([kind]) => kind);

const normalizeUserId = (userId: number) => {
  const normalized = Number(userId);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
};

const getInboxRefreshStatusKey = (userId: number) =>
  `${INBOX_REFRESH_STATUS_PREFIX}${normalizeUserId(userId)}`;

const inboxRefreshStatusSchema = v.looseObject({
  status: v.string(),
  stale: v.boolean(),
  error: v.nullable(v.string()),
  updatedAt: v.nullable(v.number()),
  lastSuccessAt: v.nullish(v.number()),
  jobId: v.nullish(v.number()),
  reason: v.optional(v.string()),
});

type InboxRefreshStatus = v.InferOutput<typeof inboxRefreshStatusSchema>;

const getStoredRefreshStatus = (userId: number): InboxRefreshStatus =>
  dbOps.getJSONSetting(getInboxRefreshStatusKey(userId), inboxRefreshStatusSchema) || {
    status: "idle",
    stale: false,
    error: null,
    updatedAt: null,
    lastSuccessAt: null,
    jobId: null,
  };

const findActiveInboxRefreshJob = (userId: number, options: { recoverExpired?: boolean } = {}) =>
  findActiveHonkerJob(
    getSystemTaskQueueName("inbox-refresh"),
    (payload) => payload?.kind === "inbox-refresh" && Number(payload.userId) === userId,
    options,
  ) ||
  findActiveHonkerJob(
    "system-task",
    (payload) => payload?.kind === "inbox-refresh" && Number(payload.userId) === userId,
    options,
  );

const setStoredRefreshStatus = (userId: number, status: Partial<InboxRefreshStatus>) => {
  db.transaction(() => {
    dbOps.setJSONSetting(getInboxRefreshStatusKey(userId), {
      ...getStoredRefreshStatus(userId),
      ...status,
      updatedAt: Date.now(),
    });
  })();
};

export function getInboxRefreshStatus(userId: number) {
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
  const job = findActiveInboxRefreshJob(normalizedUserId);
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

const upsertAll = (items: InboxItemInput[]) => {
  for (const item of items) dbOps.upsertInboxItem(item);
};

async function buildReleaseItems(userId: number, now: number) {
  const cutoff = now - RELEASE_PAST_DAYS * DAY_MS;
  const horizon = now + RELEASE_FUTURE_DAYS * DAY_MS;
  const rawAlbums = getLibraryAlbumsByReleaseDate({
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
        href: albumPath(releaseMbid),
        metadata: {
          albumMbid: releaseMbid,
          albumName: String(album?.title || "Upcoming release"),
          artistMbid,
          artistName,
          releaseDate,
          releaseType: album?.albumType || null,
        },
        expiresAt: releaseTime + CONTENT_TTL_MS,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

async function buildDiscoveryItems(userId: number, now: number) {
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
          (artist?.discoveryTier === "deeper"
            ? "A deeper discovery pick"
            : "Picked for your profile"),
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
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

type NearbyShow = {
  id: string;
  eventName?: string | null;
  dateTime?: string | null;
  date?: string | null;
  artistNames: string[];
  venueName?: string | null;
  city?: string | null;
  url?: string | null;
  image?: string | null;
};

async function buildShowItems(
  userId: number,
  now: number,
  location: ReturnType<typeof getRememberedNearbyLocation>,
  libraryArtists: ReturnType<typeof getLibraryArtistNames>,
) {
  if (!getTicketmasterApiKey() || !location || libraryArtists.length === 0) return [];
  const { shows }: { shows: NearbyShow[] } = await getNearbyShows({
    req: { ip: location.ip },
    zipCode: location.zipCode,
    countryCode: location.countryCode,
    libraryArtists,
  });
  return shows.slice(0, 60).map((show) => {
    const date = show.dateTime || show.date;
    const expiry = toTime(date) || now + RELEASE_FUTURE_DAYS * DAY_MS;
    const artistNames = show.artistNames.join(", ");
    return {
      userId,
      kind: "show",
      sourceKey: String(show.id),
      title: show.eventName || artistNames,
      subtitle: [artistNames, show.date, show.venueName, show.city].filter(Boolean).join(" · "),
      href: show.url || null,
      imageUrl: show.image || null,
      metadata: { ...show, artistNames },
      expiresAt: expiry + DAY_MS,
    };
  });
}

type NewsArticle = Awaited<ReturnType<typeof getNewsForUser>>["articles"][number];

async function buildNewsItems(userId: number, now: number, enabledKinds: Set<string>) {
  const { articles } = await getNewsForUser({ userId, limit: 100 });
  const grouped = new Map<
    string,
    { kind: string; artist: NewsArticle["artists"][number]; articles: NewsArticle[] }
  >();
  for (const article of articles) {
    for (const artist of article.artists) {
      const kind = artist.newsType === "recommended" ? "recommendedNews" : "news";
      if (!enabledKinds.has(kind)) continue;
      const day = article.publishedAt.slice(0, 10);
      const key = `${kind}:${artist.artistMbid || artist.artistName}:${day}`;
      const group = grouped.get(key) || { kind, artist, articles: [] };
      if (group.articles.length < 5) group.articles.push(article);
      grouped.set(key, group);
    }
  }

  return [...grouped.entries()].map(([key, { kind, artist, articles: dailyArticles }]) => {
    const first = dailyArticles[0];
    const sources = [...new Set(dailyArticles.map((article) => article.source).filter(Boolean))];
    return {
      userId,
      kind,
      sourceKey: key,
      title: `${artist.artistName} news`,
      subtitle: `${dailyArticles.length} ${dailyArticles.length === 1 ? "story" : "stories"}${sources.length ? ` · ${sources.slice(0, 2).join(", ")}` : ""}`,
      href: first.url,
      imageUrl: first.imageUrl,
      metadata: {
        artistMbid: artist.artistMbid,
        artistName: artist.artistName,
        newsType: artist.newsType,
        articles: dailyArticles,
      },
      expiresAt: now + CONTENT_TTL_MS,
    };
  });
}

interface RefreshInboxOptions {
  ipAddress?: string;
  zipCode?: string;
  force?: boolean;
  throwOnFailure?: boolean;
  jobId?: number | null;
}

export async function refreshInboxForUser(
  userId: number,
  {
    ipAddress = "",
    zipCode = "",
    force = false,
    throwOnFailure = false,
    jobId = null,
  }: RefreshInboxOptions = {},
) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return false;
  const state = refreshState.get(normalizedUserId);
  const location =
    zipCode || ipAddress
      ? { zipCode, countryCode: "", ip: ipAddress }
      : getRememberedNearbyLocation(normalizedUserId);
  const hasLocation = Boolean(location);
  if (
    !force &&
    state &&
    Date.now() - state.at < REFRESH_COOLDOWN_MS &&
    (!hasLocation || state.hadLocation)
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
    const libraryArtists = preferences.shows ? getLibraryArtistNames() : [];
    const enabledNewsKinds = new Set(
      getEnabledKinds(preferences).filter((kind) => ["news", "recommendedNews"].includes(kind)),
    );
    const results: PromiseSettledResult<InboxItemInput[]>[] = await Promise.allSettled([
      preferences.releases ? buildReleaseItems(normalizedUserId, now) : [],
      preferences.discoveries ? buildDiscoveryItems(normalizedUserId, now) : [],
      preferences.shows ? buildShowItems(normalizedUserId, now, location, libraryArtists) : [],
      enabledNewsKinds.size > 0 ? buildNewsItems(normalizedUserId, now, enabledNewsKinds) : [],
    ]);
    const sourceNames = ["releases", "discoveries", "shows", "news"];
    const failures = results
      .map((result, index) => ({ result, source: sourceNames[index] }))
      .filter(
        (entry): entry is typeof entry & { result: PromiseRejectedResult } =>
          entry.result.status === "rejected",
      );
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
    })();
    refreshState.set(normalizedUserId, { at: now, hadLocation: hasLocation });
    const refreshStatus =
      failures.length === 0 ? "complete" : failures.length === results.length ? "failed" : "stale";
    const errorMessage =
      failures.length > 0
        ? failures
            .map(({ result, source }) => `${source}: ${result.reason?.message || "failed"}`)
            .join("; ")
        : null;
    setStoredRefreshStatus(normalizedUserId, {
      status: refreshStatus,
      stale: failures.length > 0,
      error: errorMessage,
      ...(jobId ? { jobId } : {}),
      ...(failures.length === 0 ? { lastSuccessAt: now } : {}),
    });
    if (failures.length > 0 && throwOnFailure) {
      const error: Error & { inboxStatusWritten?: boolean } = new Error(errorMessage!);
      error.inboxStatusWritten = true;
      throw error;
    }
    return failures.length === 0;
  })()
    .catch((error) => {
      logger.warn("inbox", "Inbox refresh failed", {
        userId: normalizedUserId,
        error: error.message,
      });
      refreshState.set(normalizedUserId, { at: Date.now(), hadLocation: hasLocation });
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
    })
    .finally(() => {
      refreshInflight.delete(normalizedUserId);
    });

  refreshInflight.set(normalizedUserId, promise);
  return promise;
}

export async function enqueueInboxRefreshForUser(
  userId: number,
  {
    reason = "manual",
    zipCode = "",
    ipAddress = "",
  }: { reason?: string; zipCode?: string; ipAddress?: string } = {},
) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) throw new Error("A valid user is required");
  return withHonkerLock(`inbox-refresh:${normalizedUserId}`, async () => {
    const existing = findActiveInboxRefreshJob(normalizedUserId, { recoverExpired: true });
    if (existing) {
      return {
        queued: false,
        jobId: Number(existing.id),
        status: existing.state === "processing" ? "running" : "queued",
      };
    }

    const jobId = enqueueSystemTaskJob(
      {
        kind: "inbox-refresh",
        userId: normalizedUserId,
        reason: String(reason || "manual"),
        zipCode: String(zipCode || "").trim(),
        ipAddress: String(ipAddress || "").trim(),
      },
      { priority: reason === "manual" ? 5 : 0 },
    );
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

export async function enqueueInboxRefreshForAllUsers(
  options: Parameters<typeof enqueueInboxRefreshForUser>[1] = {},
) {
  const jobs = [];
  for (const user of userOps.getAllUsers()) {
    if (user.status !== "active") continue;
    jobs.push(await enqueueInboxRefreshForUser(user.id, options));
  }
  return jobs;
}

export function getInboxForUser(userId: number, options: { limit?: number } = {}) {
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

export const updateInboxItem = (userId: number, itemId: string, updates?: InboxItemUpdates) =>
  dbOps.updateInboxItem(userId, itemId, updates);

export const markAllInboxItemsRead = (userId: number) => {
  dbOps.markAllInboxItemsRead(userId);
  return dbOps.getInboxUnreadCount(userId);
};

export const getInboxRefreshCooldownMs = () => REFRESH_COOLDOWN_MS;
