import { isEligibleAurralRelease } from "./aurralMonitoring.js";
import { UUID_REGEX } from "../../lib/uuid.js";
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
  getHonkerQueueByName,
  getSystemTaskQueueName,
  listHonkerJobs,
} from "./honkerDb.js";
import { iterateCanonicalArtistProjection } from "./libraryQueryService.js";
import { logger } from "./logger.js";
import { getAlbumByMbid, listArtistAlbums } from "./providers/brainzmashProvider.js";
import {
  getArtistReleaseCalendar,
  isReleaseGroupOwned,
  markUnseenReleaseCalendarEntries,
  upsertReleaseCalendarEntry,
} from "./releaseCalendarStore.js";

import { acquireReleaseMetadataLease } from "./releaseMetadataLease.js";

const TASK_KIND = "release-metadata-refresh";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const text = (value) => String(value || "").trim();

function getReleaseTime(releaseDate) {
  if (!text(releaseDate)) return null;
  const releaseTime = new Date(text(releaseDate)).getTime();
  return Number.isFinite(releaseTime) ? releaseTime : null;
}

function shouldFetchReleaseDate(stored, nowMs) {
  if (!stored) return true;
  const age = nowMs - stored.refreshedAt;
  if (age > 60 * DAY_MS) return true;
  if (age < 12 * HOUR_MS) return false;
  const releaseTime = getReleaseTime(stored.releaseDate);
  return releaseTime != null && releaseTime > nowMs - 30 * DAY_MS;
}

function isValidCatalogueRelease(release) {
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
  const normalizedDelay = Math.max(0, Number(delaySeconds) || 0);
  const requestedRunAt = Math.floor(Date.now() / 1000) + normalizedDelay;
  const queueName = getSystemTaskQueueName(TASK_KIND);
  const active = [queueName, "system-task"].flatMap((name) => {
    findActiveHonkerJob(name, (payload) => payload?.kind === TASK_KIND,
      { recoverExpired: true, payloadKind: TASK_KIND });
    return listHonkerJobs(name).map((job) => ({ ...job, queue: name }));
  }).filter((job) => job.payload?.kind === TASK_KIND &&
    (job.state === "pending" || job.state === "processing"));
  const [pending, ...duplicates] = active
    .filter((job) => job.state === "pending")
    .sort((a, b) => Number(a.run_at || 0) - Number(b.run_at || 0));
  for (const job of duplicates) getHonkerQueueByName(job.queue).cancel(job.id);
  if (pending?.id) {
    const existingRunAt = Number(pending.run_at || 0);
    if (
      existingRunAt === 0 ||
      existingRunAt <= requestedRunAt
    ) {
      return pending.id;
    }
    if (!getHonkerQueueByName(pending.queue).cancel(pending.id)) return pending.id;
  }
  return enqueueSystemTaskJob(
    { kind: TASK_KIND },
    { delaySeconds: normalizedDelay, priority: -5 },
  );
}

export async function refreshReleaseMetadata({
  artists = null,
  now = Date.now(),
  signal,
  lease = null,
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
  const catalogueArtists = Array.isArray(artists)
    ? artists
    : [...iterateCanonicalArtistProjection({ pageSize: 100 })];
  const eligibleArtists = catalogueArtists.filter((artist) => UUID_REGEX.test(text(artist?.mbid)));
  let artistsRefreshed = 0;
  let artistsFailed = 0;
  let releasesSeen = 0;
  let releasesFetched = 0;
  let releasesFailed = 0;
  let releasesStale = 0;

  for (const artist of eligibleArtists) {
    const seenReleaseGroupMbids = new Set();
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
      logger.warn("library", "BrainzMash release metadata refresh failed for artist", {
        artistMbid: artist.mbid,
        message: error?.message || String(error),
      });
      continue;
    }

    const calendar = getArtistReleaseCalendar(artist.id);
    const entries = [];
    for (const release of releases) {
      if (!isEligibleAurralRelease(release)) continue;
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
            forceRefresh: true,
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
            message: error?.message || String(error),
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

    lease.write(() => {
      for (const entry of entries) upsertReleaseCalendarEntry(entry);
      releasesStale += markUnseenReleaseCalendarEntries(
        artist.id,
        seenReleaseGroupMbids,
        nowMs,
      );
    });
    artistsRefreshed += 1;
    if (artistsRefreshed % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (eligibleArtists.length > 0 && artistsRefreshed === 0) {
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
