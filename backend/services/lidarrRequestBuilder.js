import { albumHasTrackFiles } from "./albumSearchState.js";

const STALE_GRABBED_MS = 15 * 60 * 1000;

const toIso = (value) => {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const buildLidarrRequests = async (lidarrClient, snapshot = null) => {
  const [queue, history] = snapshot
    ? [snapshot.queue, snapshot.history]
    : await Promise.all([
        lidarrClient.getQueue().catch(() => []),
        lidarrClient.getHistory(1, 200).catch(() => ({ records: [] })),
      ]);

  const requestsByAlbumId = new Map();
  const queueItems = Array.isArray(queue) ? queue : queue?.records || [];
  const queueByAlbumId = new Map();
  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId == null) continue;
    queueByAlbumId.set(String(albumId), item);
  }

  for (const item of queueItems) {
    const albumId = item?.albumId ?? item?.album?.id;
    if (albumId == null) continue;

    const albumName = item?.album?.title || item?.title || "Album";
    const artistName = item?.artist?.artistName || "Artist";
    const artistMbid = item?.artist?.foreignArtistId || null;
    const qStatus = String(item.status || "").toLowerCase();
    const title = String(item.title || "").toLowerCase();
    const downloadState = String(item.trackedDownloadState || "").toLowerCase();
    const downloadStatus = String(item.trackedDownloadStatus || "").toLowerCase();
    const errMsg = String(item.errorMessage || "").toLowerCase();
    const msgs = Array.isArray(item.statusMessages)
      ? item.statusMessages.map((m) => String(m || "").toLowerCase()).join(" ")
      : "";

    const isFailed =
      downloadState === "importfailed" ||
      qStatus === "failed" ||
      title.includes("import fail") ||
      title.includes("downloaded - import fail") ||
      downloadStatus === "warning" ||
      errMsg.includes("fail") ||
      errMsg.includes("retrying") ||
      msgs.includes("fail") ||
      msgs.includes("unmatched");

    requestsByAlbumId.set(String(albumId), {
      id: `lidarr-queue-${item.id ?? albumId}`,
      source: "lidarr",
      type: "album",
      albumId: String(albumId),
      albumMbid: item?.album?.foreignAlbumId || null,
      albumName,
      artistId: item?.artist?.id != null ? String(item.artist.id) : null,
      artistMbid,
      artistName,
      status: isFailed ? "failed" : "processing",
      statusLabel: isFailed ? "Failed" : "Downloading",
      requestedAt: toIso(item?.added),
      mbid: artistMbid,
      name: albumName,
      image: null,
      inQueue: true,
      canReSearch: isFailed,
    });
  }

  const historyRecords = Array.isArray(history?.records)
    ? history.records
    : Array.isArray(history)
      ? history
      : [];

  const latestHistoryByAlbum = new Map();
  for (const record of historyRecords) {
    const albumId = record?.albumId;
    if (albumId == null) continue;
    const recordTime = new Date(record?.date || record?.eventDate || 0).getTime();
    const existing = latestHistoryByAlbum.get(String(albumId));
    if (!existing || recordTime > existing.recordTime) {
      latestHistoryByAlbum.set(String(albumId), { record, recordTime });
    }
  }

  for (const [albumId, { record, recordTime }] of latestHistoryByAlbum) {
    if (requestsByAlbumId.has(String(albumId))) continue;

    const albumName = record?.album?.title || record?.sourceTitle || "Album";
    const artistName = record?.artist?.artistName || "Artist";
    const artistMbid = record?.artist?.foreignArtistId || null;
    const eventType = String(record?.eventType || "").toLowerCase();
    const data = record?.data || {};
    const msgs = Array.isArray(data?.statusMessages)
      ? data.statusMessages.map((m) => String(m || "").toLowerCase()).join(" ")
      : String(data?.statusMessages?.[0] || "").toLowerCase();
    const errMsg = String(data?.errorMessage || "").toLowerCase();
    const sourceTitle = String(record?.sourceTitle || "").toLowerCase();
    const dataString = JSON.stringify(data).toLowerCase();
    const hasQueue = queueByAlbumId.has(String(albumId));

    const isGrabbed =
      eventType.includes("grabbed") ||
      sourceTitle.includes("grabbed") ||
      dataString.includes("grabbed");
    const isFailedDownload =
      eventType.includes("fail") ||
      msgs.includes("fail") ||
      msgs.includes("error") ||
      errMsg.includes("fail") ||
      errMsg.includes("error") ||
      sourceTitle.includes("fail") ||
      dataString.includes("fail");
    const isFailedImport =
      eventType === "albumimportincomplete" ||
      eventType.includes("incomplete") ||
      msgs.includes("fail") ||
      msgs.includes("error") ||
      msgs.includes("import fail") ||
      msgs.includes("incomplete") ||
      errMsg.includes("fail") ||
      errMsg.includes("error") ||
      sourceTitle.includes("import fail") ||
      dataString.includes("import fail");
    const isSuccessfulImport =
      eventType.includes("import") &&
      !isFailedImport &&
      eventType !== "albumimportincomplete";
    const isStaleGrabbed =
      isGrabbed && !hasQueue && Date.now() - recordTime > STALE_GRABBED_MS;
    const isActive = hasQueue || (isGrabbed && !isStaleGrabbed);

    if (isActive || isSuccessfulImport) continue;
    if (!(isFailedImport || isFailedDownload || isStaleGrabbed)) continue;

    const album = await lidarrClient.getAlbum(albumId).catch(() => null);
    if (albumHasTrackFiles(album)) continue;

    requestsByAlbumId.set(String(albumId), {
      id: `lidarr-history-${record.id || albumId}`,
      source: "lidarr",
      type: "album",
      albumId: String(albumId),
      albumMbid: record?.album?.foreignAlbumId || null,
      albumName,
      artistId: record?.artist?.id != null ? String(record.artist.id) : null,
      artistMbid,
      artistName,
      status: "failed",
      statusLabel: "Failed",
      requestedAt: toIso(record?.date || record?.eventDate),
      mbid: artistMbid,
      name: albumName,
      image: null,
      inQueue: false,
      canReSearch: true,
    });
  }

  return [...requestsByAlbumId.values()];
};
