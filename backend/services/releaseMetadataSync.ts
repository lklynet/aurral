import { FACTORY_MONITOR_RULES, releaseMatchesRules } from "./monitoring.ts";
import { fetchFreshReleases } from "./discovery/freshReleases.ts";
import { releaseMetadataQueue } from "./jobs/queues.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";
import { logger } from "./logger.ts";
import {
  hasReleaseCalendarArtists,
  projectReleaseFeed,
  releaseFeedFetchedAt,
  replaceReleaseFeed,
} from "./releaseCalendarStore.ts";
import { acquireReleaseMetadataLease } from "./releaseMetadataLease.ts";

const TASK_KIND = "release-metadata-refresh";
const FEED_DAYS = 90;
const FEED_TTL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const feedDay = (at: number) => new Date(at).toISOString().slice(0, 10);

async function fetchFeed() {
  const releases = (await fetchFreshReleases(FEED_DAYS)).filter((release) =>
    releaseMatchesRules(
      {
        id: release.releaseGroupMbid,
        type: release.type,
        secondaryTypes: release.secondaryTypes,
        releaseStatuses: [],
        firstReleaseDate: release.releaseDate,
      },
      FACTORY_MONITOR_RULES,
    ),
  );
  if (releases.length === 0) throw new Error("AurralBrainz listed no fresh releases");
  return releases;
}

export function scheduleReleaseMetadataRefresh({ delaySeconds = 0 } = {}) {
  if (!hasReleaseCalendarArtists()) return null;
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
  signal,
  lease = null,
}: {
  signal?: AbortSignal;
  lease?: ReleaseMetadataLease | null;
} = {}) {
  if (!lease) {
    const acquired = await acquireReleaseMetadataLease({ signal });
    try {
      return await refreshReleaseMetadata({ lease: acquired });
    } finally {
      acquired.release();
    }
  }
  lease.signal.throwIfAborted();
  if (!hasReleaseCalendarArtists()) return { releases: 0, gone: 0 };
  const { signal: leaseSignal } = lease;
  const fetchedAt = releaseFeedFetchedAt();
  const feed =
    fetchedAt && Date.now() - fetchedAt < FEED_TTL_MS
      ? null
      : await Promise.race([
          fetchFeed(),
          new Promise<never>((_resolve, reject) =>
            leaseSignal.addEventListener("abort", () => reject(leaseSignal.reason), {
              once: true,
            }),
          ),
        ]);
  const now = Date.now();
  let result = { releases: 0, gone: 0 };
  lease.write(() => {
    if (feed) replaceReleaseFeed(feed, now);
    result = projectReleaseFeed({
      from: feedDay(now - (FEED_DAYS - 1) * DAY_MS),
      to: feedDay(now + (FEED_DAYS - 1) * DAY_MS),
      at: now,
    });
  });
  logger.info("library", "Release calendar refreshed from ListenBrainz", result);
  return result;
}
