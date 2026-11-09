import {
  albumHasTrackFiles,
  classifyLidarrDownloadEvent,
  getLidarrAlbumsById,
} from "./albumSearchState.ts";
import type { LidarrClient, LidarrHistoryItem, LidarrQueueItem } from "./lidarrClient.ts";

const STALE_GRABBED_MS = 15 * 60 * 1000;

export interface LidarrRequestItem {
  id: string;
  source: string;
  type: string;
  albumId: string;
  albumMbid: string | null;
  albumName: string;
  artistId: string | null;
  artistMbid: string | null;
  artistName: string;
  status: string;
  statusLabel: string;
  requestedAt: string | null;
  mbid: string | null;
  name: string;
  image: null;
  inQueue: boolean;
  canReSearch: boolean;
}

const toIso = (value: string | null | undefined) => {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const buildLidarrRequests = async (
  lidarrClient: LidarrClient,
  snapshot: {
    queue: LidarrQueueItem[];
    history: LidarrHistoryItem[];
  } | null = null,
): Promise<LidarrRequestItem[]> => {
  const [queue, history] = snapshot
    ? [snapshot.queue, snapshot.history]
    : await Promise.all([
        lidarrClient.getQueue().catch(() => []),
        lidarrClient.getHistory(1, 200).catch(() => []),
      ]);

  const requestsByAlbumId = new Map<string, LidarrRequestItem>();
  for (const item of queue) {
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
    const msgs = (item.statusMessages ?? [])
      .flatMap((m) => [m.title, ...(m.messages ?? [])])
      .join(" ")
      .toLowerCase();

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

  const latestHistoryByAlbum = new Map<string, { record: LidarrHistoryItem; recordTime: number }>();
  for (const record of history) {
    if (record?.albumId == null || !classifyLidarrDownloadEvent(record.eventType)) continue;
    const albumId = String(record.albumId);
    const recordTime = new Date(record.date || 0).getTime();
    const existing = latestHistoryByAlbum.get(albumId);
    if (!existing || recordTime > existing.recordTime) {
      latestHistoryByAlbum.set(albumId, { record, recordTime });
    }
  }

  const now = Date.now();
  const failedHistory = [...latestHistoryByAlbum].filter(([albumId, { record, recordTime }]) => {
    if (requestsByAlbumId.has(albumId)) return false;
    const event = classifyLidarrDownloadEvent(record.eventType);
    return event === "failed" || (event === "grabbed" && now - recordTime > STALE_GRABBED_MS);
  });

  const albums = await getLidarrAlbumsById(
    lidarrClient,
    failedHistory.map(([albumId]) => albumId),
  );
  for (const [albumId, { record }] of failedHistory) {
    if (albumHasTrackFiles(albums.get(albumId))) continue;

    const albumName = record.album?.title || record.sourceTitle || "Album";
    const artistMbid = record.artist?.foreignArtistId || null;
    requestsByAlbumId.set(albumId, {
      id: `lidarr-history-${record.id || albumId}`,
      source: "lidarr",
      type: "album",
      albumId,
      albumMbid: record.album?.foreignAlbumId || null,
      albumName,
      artistId: record.artist?.id != null ? String(record.artist.id) : null,
      artistMbid,
      artistName: record.artist?.artistName || "Artist",
      status: "failed",
      statusLabel: "Failed",
      requestedAt: toIso(record.date),
      mbid: artistMbid,
      name: albumName,
      image: null,
      inQueue: false,
      canReSearch: true,
    });
  }

  return [...requestsByAlbumId.values()];
};
