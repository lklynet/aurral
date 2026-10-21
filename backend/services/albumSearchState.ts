import type { LidarrClient } from "./lidarrClient.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";

const MIN_SEARCH_MS = 30 * 1000;
const STALE_SEARCH_MS = 5 * 60 * 1000;
const RECENT_COMMAND_MS = 2 * 60 * 60 * 1000;
const RECENT_HISTORY_MS = 60 * 60 * 1000;
const ALBUM_LOOKUP_TTL_MS = 30 * 1000;
const ALBUM_LOOKUP_CONCURRENCY = 4;
export interface LidarrAlbum {
  id?: number;
  title?: string;
  statistics?: { trackFileCount?: number };
  artist?: { id?: number; artistName?: string; foreignArtistId?: string };
}

export interface LidarrQueueItem {
  id?: number;
  albumId?: number | null;
  album?: { id?: number; title?: string; foreignAlbumId?: string };
  artist?: { id?: number; artistName?: string; foreignArtistId?: string };
  title?: string;
  added?: string;
  status?: string;
  errorMessage?: string;
  statusMessages?: unknown[];
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  size?: number;
  sizeleft?: number;
}

export interface LidarrHistoryRecord {
  id?: number;
  albumId?: number | null;
  album?: { title?: string; foreignAlbumId?: string };
  artist?: { id?: number; artistName?: string; foreignArtistId?: string };
  sourceTitle?: string;
  date?: string;
  eventDate?: string;
  eventType?: string;
  data?: { statusMessages?: unknown[] | string | Record<number, unknown>; errorMessage?: string };
}

interface LidarrCommand {
  name?: string;
  commandName?: string;
  status?: string;
  ended?: string;
  completedAt?: string;
  endTime?: string;
  body?: { albumIds?: number[] };
  albumIds?: number[];
}

export type LidarrRecords<T> = T[] | { records?: T[] } | null;

type AlbumLookup = { at: number; album: Promise<LidarrAlbum | null | undefined> };

const albumLookupsByClient = new WeakMap<LidarrClient, Map<string, AlbumLookup>>();

const normalizeItems = <T>(value: LidarrRecords<T> | undefined): T[] =>
  Array.isArray(value) ? value : value?.records || [];

export const albumHasTrackFiles = (album: LidarrAlbum | null | undefined) =>
  Number(album?.statistics?.trackFileCount || 0) > 0;

export const getLidarrAlbumsById = async (
  lidarrClient: LidarrClient,
  albumIds: (string | number)[],
) => {
  const lookups = albumLookupsByClient.get(lidarrClient) || new Map<string, AlbumLookup>();
  albumLookupsByClient.set(lidarrClient, lookups);
  const now = Date.now();
  for (const [albumId, lookup] of lookups) {
    if (now - lookup.at >= ALBUM_LOOKUP_TTL_MS) lookups.delete(albumId);
  }
  const ids = [...new Set(albumIds.map(String))];
  const missing = ids.filter((albumId) => !lookups.has(albumId));
  // A failed lookup is undefined, so callers can tell it from a deleted
  // album, which Lidarr answers with 404 and getAlbum resolves to null.
  const fetched = mapWithConcurrency(missing, ALBUM_LOOKUP_CONCURRENCY, (albumId: string) =>
    lidarrClient.getAlbum(albumId).catch(() => undefined),
  );
  missing.forEach((albumId, index) => {
    lookups.set(albumId, { at: now, album: fetched.then((albums) => albums[index]) });
  });
  const albums = await Promise.all(ids.map((albumId) => lookups.get(albumId)!.album));
  return new Map(
    ids.map((albumId, index): [string, LidarrAlbum | null | undefined] => [albumId, albums[index]]),
  );
};

const getCommandAlbumIds = (command: LidarrCommand | null | undefined) => {
  if (Array.isArray(command?.body?.albumIds)) return command.body.albumIds;
  if (Array.isArray(command?.albumIds)) return command.albumIds;
  return [];
};

const IMPORTED_EVENTS = new Set(["downloadimported", "trackfileimported", "artistfolderimported"]);
const FAILED_EVENTS = new Set(["downloadfailed", "albumimportincomplete", "downloadignored"]);
const FAILED_QUEUE_STATES = new Set([
  "downloadfailed",
  "downloadfailedpending",
  "importblocked",
  "importfailed",
]);

// Lidarr history event types. Rename, retag, and delete events describe
// files already in the library, so they say nothing about a download.
export function classifyLidarrDownloadEvent(eventType: string | null | undefined) {
  const type = String(eventType || "")
    .trim()
    .toLowerCase();
  if (type === "grabbed") return "grabbed";
  if (IMPORTED_EVENTS.has(type)) return "imported";
  if (FAILED_EVENTS.has(type)) return "failed";
  return null;
}

export function readLidarrQueueItemStatus(item: LidarrQueueItem | null | undefined) {
  const state = String(item?.trackedDownloadState || "")
    .trim()
    .toLowerCase();
  const health = String(item?.trackedDownloadStatus || "")
    .trim()
    .toLowerCase();
  const failed =
    FAILED_QUEUE_STATES.has(state) ||
    String(item?.status || "")
      .trim()
      .toLowerCase() === "failed" ||
    health === "error" ||
    (health === "warning" && state !== "downloading");
  if (failed) return { status: "failed" };
  const size = Number(item?.size || 0);
  const sizeLeft = Number(item?.sizeleft || 0);
  return { status: "downloading", progress: size ? Math.round((1 - sizeLeft / size) * 100) : 0 };
}

export const parseLidarrSearchContext = ({
  queue,
  history,
  commands,
}: {
  queue?: LidarrRecords<LidarrQueueItem>;
  history?: LidarrRecords<LidarrHistoryRecord>;
  commands?: LidarrRecords<LidarrCommand>;
} = {}) => {
  const queueItems = normalizeItems(queue);
  const historyItems = normalizeItems(history);
  const commandItems = normalizeItems(commands);
  const now = Date.now();
  const searchingAlbumIds = new Set<number>();
  const recentlyCompletedSearchAlbumIds = new Set<number>();
  const queueAlbumIds = new Set<number>();
  const importedAlbumIds = new Set<number>();
  const grabbedAlbumIds = new Set<number>();
  const activeHistoryAlbumIds = new Set<number>();

  for (const command of commandItems) {
    const name = String(command?.name || command?.commandName || "")
      .toLowerCase()
      .trim();
    if (!name.includes("albumsearch")) continue;
    const albumIds = getCommandAlbumIds(command);
    const status = String(command?.status || "")
      .toLowerCase()
      .trim();
    if (
      status === "completed" ||
      status === "failed" ||
      status === "aborted" ||
      status === "canceled" ||
      status === "cancelled"
    ) {
      const endedAt = new Date(
        command?.ended || command?.completedAt || command?.endTime || 0,
      ).getTime();
      if (endedAt > 0 && now - endedAt <= RECENT_COMMAND_MS) {
        for (const id of albumIds) {
          if (id != null) recentlyCompletedSearchAlbumIds.add(id);
        }
      }
      continue;
    }
    for (const id of albumIds) {
      if (id != null) searchingAlbumIds.add(id);
    }
  }

  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId != null) queueAlbumIds.add(albumId);
  }

  for (const record of historyItems) {
    const albumId = record?.albumId;
    if (albumId == null) continue;
    const recordTime = new Date(record?.date || record?.eventDate || 0).getTime();
    if (!Number.isFinite(recordTime) || now - recordTime > RECENT_HISTORY_MS) {
      continue;
    }
    const event = classifyLidarrDownloadEvent(record?.eventType);
    if (event === "imported") {
      importedAlbumIds.add(albumId);
      activeHistoryAlbumIds.add(albumId);
      continue;
    }
    if (event === "grabbed") {
      grabbedAlbumIds.add(albumId);
      activeHistoryAlbumIds.add(albumId);
    }
  }

  return {
    searchingAlbumIds,
    recentlyCompletedSearchAlbumIds,
    queueAlbumIds,
    importedAlbumIds,
    grabbedAlbumIds,
    activeHistoryAlbumIds,
  };
};

type LidarrSearchContext = ReturnType<typeof parseLidarrSearchContext>;

export const resolveAlbumSearchOutcome = (
  albumId: string | number,
  context: LidarrSearchContext,
  {
    searchStartedAt = 0,
    albumHasFiles = false,
  }: { searchStartedAt?: number; albumHasFiles?: boolean } = {},
) => {
  const lidarrAlbumId = parseInt(String(albumId), 10);
  if (isNaN(lidarrAlbumId) || !context) return null;

  const {
    searchingAlbumIds,
    recentlyCompletedSearchAlbumIds,
    queueAlbumIds,
    importedAlbumIds,
    grabbedAlbumIds,
    activeHistoryAlbumIds,
  } = context;

  if (albumHasFiles || importedAlbumIds?.has(lidarrAlbumId)) {
    return { status: "completed" };
  }
  if (searchingAlbumIds.has(lidarrAlbumId)) {
    return { status: "searching" };
  }
  if (queueAlbumIds.has(lidarrAlbumId)) {
    return { status: "downloading" };
  }
  if (grabbedAlbumIds?.has(lidarrAlbumId) || activeHistoryAlbumIds.has(lidarrAlbumId)) {
    return { status: "processing" };
  }

  const age = searchStartedAt > 0 ? Date.now() - searchStartedAt : 0;
  if (age > 0 && age < MIN_SEARCH_MS) {
    return { status: "searching" };
  }

  if (recentlyCompletedSearchAlbumIds.has(lidarrAlbumId)) {
    return { status: "failed", statusLabel: "Not found" };
  }

  if (age >= STALE_SEARCH_MS) {
    return { status: "failed", statusLabel: "Not found" };
  }

  if (searchStartedAt > 0) {
    return { status: "searching" };
  }

  return null;
};
