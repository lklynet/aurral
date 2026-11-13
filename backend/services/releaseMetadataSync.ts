import { FACTORY_MONITOR_RULES, releaseMatchesRules } from "./monitoring.ts";
import { UUID_REGEX } from "../../lib/uuid.ts";
import { asAppError } from "../../lib/errors.ts";
import { releaseMetadataQueue } from "./jobs/queues.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";
import { logger } from "./logger.ts";
import { getAlbumByMbid, listArtistAlbums } from "./providers/brainzmashProvider.ts";
import {
  getArtistReleaseCalendar,
  getReleaseCalendarArtistRefreshes,
  isReleaseGroupOwned,
  isLibraryArtist,
  listReleaseCalendarArtists,
  markReleaseCalendarArtistFailed,
  markReleaseCalendarArtistRefreshed,
  markUnseenReleaseCalendarEntries,
  upsertReleaseCalendarEntry,
} from "./releaseCalendarStore.ts";

import { acquireReleaseMetadataLease } from "./releaseMetadataLease.ts";

const TASK_KIND = "release-metadata-refresh";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ARTIST_REFRESH_INTERVAL_MS = 7 * DAY_MS;
const ARTIST_FAILURE_RETRY_MS = HOUR_MS;

const text = (value: unknown) => String(value || "").trim();

function getReleaseTime(releaseDate: unknown) {
  if (!text(releaseDate)) return null;
  const releaseTime = new Date(text(releaseDate)).getTime();
  return Number.isFinite(releaseTime) ? releaseTime : null;
}

function shouldFetchReleaseDate(
  stored: { releaseDate: string | null; refreshedAt: number } | undefined,
  nowMs: number,
) {
  if (!stored) return true;
  const age = nowMs - stored.refreshedAt;
  if (age < 12 * HOUR_MS) return false;
  const releaseTime = getReleaseTime(stored.releaseDate);
  if (releaseTime == null) return age > 60 * DAY_MS;
  return releaseTime > nowMs - 30 * DAY_MS;
}

type CalendarArtist = ReturnType<typeof listReleaseCalendarArtists>[number];

function listArtistsDue(artists: CalendarArtist[], nowMs: number) {
  const refreshes = getReleaseCalendarArtistRefreshes();
  return artists.filter((artist) => {
    if (!UUID_REGEX.test(text(artist?.mbid))) return false;
    const refresh = refreshes.get(String(artist.id));
    return (
      !refresh ||
      (nowMs - refresh.refreshedAt >= ARTIST_REFRESH_INTERVAL_MS &&
        nowMs - refresh.failedAt >= ARTIST_FAILURE_RETRY_MS)
    );
  });
}

function isValidCatalogueRelease(
  release: { id?: unknown; title?: unknown; type?: unknown } | null | undefined,
) {
  const releaseGroupMbid = text(release?.id);
  return Boolean(
    release &&
    typeof release === "object" &&
    UUID_REGEX.test(releaseGroupMbid) &&
    text(release.title) &&
    text(release.type),
  );
}

export function scheduleReleaseMetadataRefresh({ delaySeconds = 0 } = {}) {
  if (listArtistsDue(listReleaseCalendarArtists(), Date.now()).length === 0) return null;
  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const pending = releaseMetadataQueue.list().find((job) => job.state === "pending");
  if (pending) {
    if (pending.run_at <= Date.now() + delayMs) return pending.id;
    if (!releaseMetadataQueue.cancel(pending.id)) return pending.id;
  }
  return enqueueSystemTask({ kind: TASK_KIND }, { delayMs, priority: -5 });
}

type ReleaseMetadataLease = Awaited<ReturnType<typeof acquireReleaseMetadataLease>>;

export async function refreshReleaseMetadata({
  artists = null,
  now = Date.now(),
  signal,
  lease = null,
}: {
  artists?: CalendarArtist[] | null;
  now?: number;
  signal?: AbortSignal;
  lease?: ReleaseMetadataLease | null;
} = {}) {
  if (!lease) {
    const acquired = await acquireReleaseMetadataLease({ signal });
    try {
      return await refreshReleaseMetadata({ artists, now, lease: acquired });
    } finally {
      acquired.release();
    }
  }
  lease.signal.throwIfAborted();
  const requestedNow = new Date(now).getTime();
  const nowMs = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const eligibleArtists = listArtistsDue(
    Array.isArray(artists) ? artists : listReleaseCalendarArtists(),
    nowMs,
  );
  let artistsRefreshed = 0;
  let artistsFailed = 0;
  let releasesSeen = 0;
  let releasesFetched = 0;
  let releasesFailed = 0;
  let releasesStale = 0;

  for (const artist of eligibleArtists) {
    const seenReleaseGroupMbids = new Set<string>();
    let releases;
    try {
      releases = await listArtistAlbums(artist.mbid, {
        hydrateLimit: 0,
        forceRefresh: true,
        signal: lease.signal,
      });
      if (!Array.isArray(releases)) {
        throw new Error("BrainzMash returned a malformed artist release catalogue");
      }
      if (releases.some((release) => !isValidCatalogueRelease(release))) {
        throw new Error("BrainzMash returned malformed release metadata");
      }
    } catch (error) {
      lease.signal.throwIfAborted();
      artistsFailed += 1;
      lease.write(() => {
        if (isLibraryArtist(artist.id)) markReleaseCalendarArtistFailed(artist.id, nowMs);
      });
      logger.warn("library", "BrainzMash release metadata refresh failed for artist", {
        artistMbid: artist.mbid,
        message: asAppError(error)?.message || String(error),
      });
      continue;
    }

    const calendar = getArtistReleaseCalendar(artist.id);
    const entries: Parameters<typeof upsertReleaseCalendarEntry>[0][] = [];
    for (const release of releases) {
      if (!releaseMatchesRules(release, FACTORY_MONITOR_RULES)) continue;
      const releaseGroupMbid = text(release.id);
      releasesSeen += 1;
      seenReleaseGroupMbids.add(releaseGroupMbid);
      if (isReleaseGroupOwned(releaseGroupMbid)) continue;
      const stored = calendar.get(releaseGroupMbid);
      let releaseDate = stored?.releaseDate || "";
      let refreshedAt = stored?.refreshedAt;
      if (shouldFetchReleaseDate(stored, nowMs)) {
        try {
          const album = await getAlbumByMbid(releaseGroupMbid, {
            signal: lease.signal,
          });
          releaseDate = text(album?.releaseDate) || releaseDate;
          refreshedAt = nowMs;
          releasesFetched += 1;
        } catch (error) {
          lease.signal.throwIfAborted();
          releasesFailed += 1;
          logger.warn("library", "BrainzMash release date refresh failed", {
            releaseGroupMbid,
            message: asAppError(error)?.message || String(error),
          });
          continue;
        }
      }
      entries.push({
        releaseGroupMbid,
        artistId: artist.id,
        title: text(release.title) || "Unknown Album",
        releaseDate,
        releaseType: release.type || null,
        secondaryTypes: release.secondaryTypes,
        releaseStatuses: release.releaseStatuses,
        refreshedAt,
      });
    }

    let stillInLibrary = false;
    lease.write(() => {
      stillInLibrary = isLibraryArtist(artist.id);
      if (!stillInLibrary) return;
      for (const entry of entries) upsertReleaseCalendarEntry(entry);
      releasesStale += markUnseenReleaseCalendarEntries(artist.id, seenReleaseGroupMbids, nowMs);
      markReleaseCalendarArtistRefreshed(artist.id, nowMs);
    });
    if (!stillInLibrary) continue;
    artistsRefreshed += 1;
    if (artistsRefreshed % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (artistsFailed > 0 && artistsRefreshed === 0) {
    throw new Error("BrainzMash release metadata refresh failed for every library artist");
  }

  logger.info("library", "BrainzMash release metadata refreshed", {
    artists: eligibleArtists.length,
    artistsRefreshed,
    artistsFailed,
    releases: releasesSeen,
    releaseDatesFetched: releasesFetched,
    releaseDatesFailed: releasesFailed,
    staleReleases: releasesStale,
  });
  return {
    artistsSeen: eligibleArtists.length,
    artistsRefreshed,
    artistsFailed,
    releasesSeen,
    releasesFetched,
    releasesFailed,
    releasesStale,
  };
}
