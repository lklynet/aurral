import { mapWithConcurrency } from "./discovery/helpers.js";

const MIN_SEARCH_MS = 30 * 1000;
const STALE_SEARCH_MS = 5 * 60 * 1000;
const RECENT_COMMAND_MS = 2 * 60 * 60 * 1000;
const RECENT_HISTORY_MS = 60 * 60 * 1000;
const ALBUM_LOOKUP_TTL_MS = 30 * 1000;
const ALBUM_LOOKUP_CONCURRENCY = 4;
const albumLookupsByClient = new WeakMap();

const normalizeItems = (value) => (Array.isArray(value) ? value : value?.records || []);

export const albumHasTrackFiles = (album) =>
  Number(album?.statistics?.trackFileCount || 0) > 0;

export const getLidarrAlbumsById = async (lidarrClient, albumIds) => {
  const lookups = albumLookupsByClient.get(lidarrClient) || new Map();
  albumLookupsByClient.set(lidarrClient, lookups);
  const now = Date.now();
  for (const [albumId, lookup] of lookups) {
    if (now - lookup.at >= ALBUM_LOOKUP_TTL_MS) lookups.delete(albumId);
  }
  const ids = [...new Set(albumIds.map(String))];
  const missing = ids.filter((albumId) => !lookups.has(albumId));
  const fetched = mapWithConcurrency(missing, ALBUM_LOOKUP_CONCURRENCY, (albumId) =>
    lidarrClient.getAlbum(albumId).catch(() => null));
  missing.forEach((albumId, index) => {
    lookups.set(albumId, { at: now, album: fetched.then((albums) => albums[index]) });
  });
  const albums = await Promise.all(ids.map((albumId) => lookups.get(albumId).album));
  return new Map(ids.map((albumId, index) => [albumId, albums[index]]));
};

const getCommandAlbumIds = (command) => {
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
export function classifyLidarrDownloadEvent(eventType) {
  const type = String(eventType || "").trim().toLowerCase();
  if (type === "grabbed") return "grabbed";
  if (IMPORTED_EVENTS.has(type)) return "imported";
  if (FAILED_EVENTS.has(type)) return "failed";
  return null;
}

export function readLidarrQueueItemStatus(item) {
  const state = String(item?.trackedDownloadState || "").trim().toLowerCase();
  const health = String(item?.trackedDownloadStatus || "").trim().toLowerCase();
  const failed = FAILED_QUEUE_STATES.has(state)
    || String(item?.status || "").trim().toLowerCase() === "failed"
    || health === "error"
    || (health === "warning" && state !== "downloading");
  if (failed) return { status: "failed" };
  const size = Number(item?.size || 0);
  const sizeLeft = Number(item?.sizeleft || 0);
  return { status: "downloading", progress: size ? Math.round((1 - sizeLeft / size) * 100) : 0 };
}

export const parseLidarrSearchContext = ({ queue, history, commands } = {}) => {
  const queueItems = normalizeItems(queue);
  const historyItems = normalizeItems(history);
  const commandItems = normalizeItems(commands);
  const now = Date.now();
  const searchingAlbumIds = new Set();
  const recentlyCompletedSearchAlbumIds = new Set();
  const queueAlbumIds = new Set();
  const importedAlbumIds = new Set();
  const grabbedAlbumIds = new Set();
  const activeHistoryAlbumIds = new Set();

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

export const resolveAlbumSearchOutcome = (
  albumId,
  context,
  { searchStartedAt = 0, albumHasFiles = false } = {},
) => {
  const lidarrAlbumId = parseInt(albumId, 10);
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
