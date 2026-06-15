const MIN_SEARCH_MS = 30 * 1000;
const STALE_SEARCH_MS = 5 * 60 * 1000;
const RECENT_COMMAND_MS = 2 * 60 * 60 * 1000;
const RECENT_HISTORY_MS = 60 * 60 * 1000;

const normalizeItems = (value) =>
  Array.isArray(value) ? value : value?.records || [];

const getCommandAlbumIds = (command) => {
  if (Array.isArray(command?.body?.albumIds)) return command.body.albumIds;
  if (Array.isArray(command?.albumIds)) return command.albumIds;
  return [];
};

export const parseLidarrSearchContext = ({ queue, history, commands } = {}) => {
  const queueItems = normalizeItems(queue);
  const historyItems = normalizeItems(history);
  const commandItems = normalizeItems(commands);
  const now = Date.now();
  const searchingAlbumIds = new Set();
  const recentlyCompletedSearchAlbumIds = new Set();
  const queueAlbumIds = new Set();
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
    const eventType = String(record?.eventType || "").toLowerCase();
    const sourceTitle = String(record?.sourceTitle || "").toLowerCase();
    const dataString = JSON.stringify(record?.data || {}).toLowerCase();
    const isGrabbed =
      eventType.includes("grabbed") ||
      sourceTitle.includes("grabbed") ||
      dataString.includes("grabbed");
    const isImport = eventType.includes("import");
    if (isGrabbed || isImport) {
      activeHistoryAlbumIds.add(albumId);
    }
  }

  return {
    searchingAlbumIds,
    recentlyCompletedSearchAlbumIds,
    queueAlbumIds,
    activeHistoryAlbumIds,
  };
};

export const resolveAlbumSearchOutcome = (
  albumId,
  context,
  { searchStartedAt = 0 } = {},
) => {
  const lidarrAlbumId = parseInt(albumId, 10);
  if (isNaN(lidarrAlbumId) || !context) return null;

  const {
    searchingAlbumIds,
    recentlyCompletedSearchAlbumIds,
    queueAlbumIds,
    activeHistoryAlbumIds,
  } = context;

  if (searchingAlbumIds.has(lidarrAlbumId)) {
    return { status: "searching" };
  }
  if (queueAlbumIds.has(lidarrAlbumId)) {
    return { status: "downloading" };
  }
  if (activeHistoryAlbumIds.has(lidarrAlbumId)) {
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
