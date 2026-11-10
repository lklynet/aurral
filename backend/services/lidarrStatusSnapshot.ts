import { asAppError } from "../../lib/errors.ts";
import {
  albumHasTrackFiles,
  classifyLidarrDownloadEvent,
  getLidarrAlbumsById,
  parseLidarrSearchContext,
  readLidarrQueueItemStatus,
  resolveAlbumSearchOutcome,
} from "./albumSearchState.ts";
import {
  lidarrClient,
  type LidarrCommand,
  type LidarrHistoryItem,
  type LidarrQueueItem,
} from "./lidarrClient.ts";
import { logger } from "./logger.ts";

type LidarrProviderSnapshot = {
  queue: LidarrQueueItem[];
  history: LidarrHistoryItem[];
  commands: LidarrCommand[];
};

export type AlbumDownloadStatus = { status: string; updatedAt: string };

type LidarrStatusSnapshot = {
  provider: LidarrProviderSnapshot;
  statuses: Record<string, AlbumDownloadStatus>;
  updatedAt: string | null;
  active: boolean;
  stale: boolean;
  error: string | null;
};

type LidarrStatusCache = {
  snapshot: LidarrStatusSnapshot | null;
  pending: Promise<LidarrStatusSnapshot> | null;
  failures: number;
  checkedAt: number;
  nextRefreshAt: number;
  revision: number;
};

const STALE_GRABBED_MS = 15 * 60 * 1000;
const ACTIVE_STATUS_CACHE_MS = 10 * 1000;
const IDLE_STATUS_CACHE_MS = 60 * 1000;
const MAX_STATUS_RETRY_MS = 2 * 60 * 1000;
let allDownloadStatusesCache: LidarrStatusCache = {
  snapshot: null,
  pending: null,
  failures: 0,
  checkedAt: 0,
  nextRefreshAt: 0,
  revision: 0,
};

const activeDownloadStatuses = new Set(["searching", "downloading", "processing"]);

const snapshotHasActiveWork = (statuses: Record<string, AlbumDownloadStatus>) =>
  Object.values(statuses || {}).some((status) => activeDownloadStatuses.has(status?.status));

export const getDownloadStatusesForAlbumIds = async (
  albumIdArrayInput: unknown,
  snapshot: LidarrProviderSnapshot | null = null,
) => {
  const albumIdArray = Array.isArray(albumIdArrayInput) ? albumIdArrayInput.map(String) : [];
  const statuses: Record<string, AlbumDownloadStatus> = {};

  if (lidarrClient.isConfigured()) {
    try {
      const { queue, history, commands } = snapshot || (await getLidarrStatusSnapshot()).provider;
      const searchContext = parseLidarrSearchContext({
        queue,
        history,
        commands,
      });
      const { searchingAlbumIds } = searchContext;

      const latestHistoryByAlbumId = new Map<
        number,
        { event: NonNullable<ReturnType<typeof classifyLidarrDownloadEvent>>; historyTime: number }
      >();
      for (const h of history) {
        if (h?.albumId == null) continue;
        const event = classifyLidarrDownloadEvent(h?.eventType);
        if (!event) continue;
        const historyTime = new Date(h?.date || 0).getTime();
        const existing = latestHistoryByAlbumId.get(h.albumId);
        if (!existing || historyTime > existing.historyTime) {
          latestHistoryByAlbumId.set(h.albumId, { event, historyTime });
        }
      }

      const queueByAlbumId = new Map<number, LidarrQueueItem>();
      for (const q of queue) {
        const qAlbumId = q?.albumId ?? q?.album?.id;
        if (qAlbumId == null) continue;
        queueByAlbumId.set(qAlbumId, q);
      }

      const unverified = new Map<string, number>();
      for (const albumId of albumIdArray) {
        if (!albumId || albumId === "undefined" || albumId === "null") continue;
        const lidarrAlbumId = parseInt(albumId, 10);
        if (isNaN(lidarrAlbumId)) continue;
        const updatedAt = new Date().toISOString();

        const queueItem = queueByAlbumId.get(lidarrAlbumId);
        if (queueItem) {
          statuses[albumId] = { ...readLidarrQueueItemStatus(queueItem), updatedAt };
          continue;
        }

        if (searchingAlbumIds.has(lidarrAlbumId)) {
          statuses[albumId] = { status: "searching", updatedAt };
          continue;
        }

        const historyEntry = latestHistoryByAlbumId.get(lidarrAlbumId);
        if (historyEntry) {
          const staleGrab =
            historyEntry.event === "grabbed" &&
            Date.now() - historyEntry.historyTime > STALE_GRABBED_MS;
          if (historyEntry.event === "imported") {
            statuses[albumId] = { status: "added", updatedAt };
          } else if (historyEntry.event === "failed" || staleGrab) {
            unverified.set(albumId, lidarrAlbumId);
          } else {
            statuses[albumId] = { status: "processing", updatedAt };
          }
          continue;
        }

        const searchOutcome = resolveAlbumSearchOutcome(lidarrAlbumId, searchContext);
        if (searchOutcome?.status === "failed") {
          statuses[albumId] = {
            status: "failed",
            updatedAt: new Date().toISOString(),
          };
        } else if (searchOutcome?.status === "searching") {
          statuses[albumId] = {
            status: "searching",
            updatedAt: new Date().toISOString(),
          };
        }
      }

      const albums = await getLidarrAlbumsById(lidarrClient, [...unverified.values()]);
      const updatedAt = new Date().toISOString();
      for (const [albumId, lidarrAlbumId] of unverified) {
        const hasFiles = albumHasTrackFiles(albums.get(String(lidarrAlbumId)));
        statuses[albumId] = { status: hasFiles ? "added" : "failed", updatedAt };
      }
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("downloads", "Failed to fetch Lidarr status:", { message: failure?.message });
    }
  }

  return statuses;
};

const computeLidarrStatusSnapshot = async () => {
  if (!lidarrClient.isConfigured()) {
    return { provider: { queue: [], history: [], commands: [] }, statuses: {} };
  }

  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue({ forceRefresh: true }),
    lidarrClient.getHistory(1, 200, "date", "descending", { forceRefresh: true }),
    lidarrClient.getCommands({ forceRefresh: true }),
  ]);
  const provider: LidarrProviderSnapshot = { queue, history, commands };
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const albumIds = new Set<string>();
  const searchContext = parseLidarrSearchContext({ queue, history, commands });

  for (const item of queue) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId != null) albumIds.add(String(albumId));
  }
  for (const item of history) {
    if (item?.albumId == null) continue;
    const historyTime = new Date(item?.date || 0).getTime();
    if (historyTime > oneHourAgo) albumIds.add(String(item.albumId));
  }
  for (const albumId of searchContext.searchingAlbumIds) {
    albumIds.add(String(albumId));
  }

  const statuses = await getDownloadStatusesForAlbumIds([...albumIds], provider);
  return { provider, statuses };
};

export const invalidateAllDownloadStatusesCache = () => {
  allDownloadStatusesCache.revision += 1;
  allDownloadStatusesCache.nextRefreshAt = 0;
};

export const hasActiveLidarrStatusSnapshot = () =>
  allDownloadStatusesCache.snapshot?.active === true;

const staleSnapshot = (error: unknown): LidarrStatusSnapshot => ({
  ...(allDownloadStatusesCache.snapshot || {
    provider: { queue: [], history: [], commands: [] },
    statuses: {},
    updatedAt: null,
    active: false,
  }),
  stale: true,
  error: asAppError(error)?.message || String(error),
});

export const getLidarrStatusSnapshot = async ({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<LidarrStatusSnapshot> => {
  if (lidarrClient.isCircuitOpen()) {
    return staleSnapshot("Lidarr circuit is open");
  }

  const now = Date.now();
  const maxAgeMs = refresh ? ACTIVE_STATUS_CACHE_MS : Infinity;
  if (
    allDownloadStatusesCache.snapshot &&
    now < allDownloadStatusesCache.nextRefreshAt &&
    now - allDownloadStatusesCache.checkedAt < maxAgeMs
  ) {
    return allDownloadStatusesCache.snapshot;
  }
  if (allDownloadStatusesCache.pending) {
    return allDownloadStatusesCache.pending;
  }

  const refreshRevision = allDownloadStatusesCache.revision;
  allDownloadStatusesCache.pending = computeLidarrStatusSnapshot()
    .then(({ provider, statuses }) => {
      const active = snapshotHasActiveWork(statuses);
      const refreshedAt = Date.now();
      const snapshot = {
        provider,
        statuses,
        updatedAt: new Date(refreshedAt).toISOString(),
        active,
        stale: false,
        error: null,
      };
      allDownloadStatusesCache.snapshot = snapshot;
      allDownloadStatusesCache.checkedAt = refreshedAt;
      allDownloadStatusesCache.failures = 0;
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision
          ? refreshedAt + (active ? ACTIVE_STATUS_CACHE_MS : IDLE_STATUS_CACHE_MS)
          : 0;
      return snapshot;
    })
    .catch((error) => {
      allDownloadStatusesCache.failures += 1;
      allDownloadStatusesCache.checkedAt = Date.now();
      const retryAt =
        allDownloadStatusesCache.checkedAt +
        Math.min(
          MAX_STATUS_RETRY_MS,
          ACTIVE_STATUS_CACHE_MS * 2 ** (allDownloadStatusesCache.failures - 1),
        );
      allDownloadStatusesCache.nextRefreshAt =
        refreshRevision === allDownloadStatusesCache.revision ? retryAt : 0;
      logger.warn("downloads", "Failed to refresh Lidarr status:", {
        message: asAppError(error)?.message,
      });
      const snapshot = staleSnapshot(error);
      allDownloadStatusesCache.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      allDownloadStatusesCache.pending = null;
    });

  return allDownloadStatusesCache.pending;
};

export const getAllDownloadStatuses = async () => (await getLidarrStatusSnapshot()).statuses;

const ACTIVE_LIDARR_ALBUM_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

export const getActiveLidarrAlbums = async () => {
  if (!lidarrClient.isConfigured()) return [];
  const { statuses } = await getLidarrStatusSnapshot();
  const activeIds = new Set(
    Object.entries(statuses || {})
      .filter(([, entry]) => ACTIVE_LIDARR_ALBUM_STATUSES.has(entry?.status))
      .map(([albumId]) => String(albumId)),
  );
  if (activeIds.size === 0) return [];
  const albums = await getLidarrAlbumsById(lidarrClient, [...activeIds]);
  return [...albums.values()].filter((album) => album != null);
};
