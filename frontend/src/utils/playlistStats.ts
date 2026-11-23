import type { InferResponseType } from "hono/client";
import type { playlistJobsClient } from "./api/clients/playlistJobs.ts";

type PlaylistStatusSnapshot = InferResponseType<typeof playlistJobsClient.status.$get, 200>;

export type Flow = PlaylistStatusSnapshot["flows"][number];

export type PlaylistStats = PlaylistStatusSnapshot["stats"];

export interface StaticPlaylist {
  artworkRevision?: number;
  id: string;
  name: string;
  ownerUserId: number | null;
  ownerUsername: string | null;
  members?: { id: number; username: string; handle: string | null }[];
  sourceName: string | null;
  sourceFlowId: string | null;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
  recordHistory: boolean;
  showTrackAvailability: boolean;
  importSource: PlaylistStatusSnapshot["staticPlaylists"][number]["importSource"];
}

export type PlaylistStatus = Omit<PlaylistStatusSnapshot, "staticPlaylists"> & {
  staticPlaylists: StaticPlaylist[];
};

const statCount = (value: number | null | undefined) => Number(value || 0);

export const getFlowDisplayTrackCount = (
  flow: Partial<Flow> | null | undefined,
  stats: PlaylistStats | null | undefined,
  trackListLength = 0,
) => {
  const found = Math.max(statCount(trackListLength), statCount(stats?.total));
  return found > 0 ? found : statCount(flow?.size);
};

export const getStaticPlaylistTrackCount = (
  playlist: Partial<StaticPlaylist> | null | undefined,
  stats: PlaylistStats | null | undefined,
  trackListLength = 0,
) => {
  return Math.max(
    statCount(playlist?.trackCount),
    statCount(trackListLength),
    statCount(stats?.total),
  );
};

export const EMPTY_PLAYLIST_STATS: PlaylistStats = {
  total: 0,
  done: 0,
  pending: 0,
  downloading: 0,
  blocked: 0,
  failed: 0,
};

export const parseFlowTimestamp = (value: number | string | null | undefined) =>
  typeof value === "number" ? value : Number.parseInt(String(value), 10);

export const sanitizePlaylistStats = (stats: Partial<PlaylistStats> | null | undefined) => {
  const pending = statCount(stats?.pending);
  const downloading = statCount(stats?.downloading);
  const blocked = statCount(stats?.blocked);
  const done = statCount(stats?.done);
  const failed = statCount(stats?.failed);
  return {
    total: pending + downloading + blocked + done + failed,
    pending,
    downloading,
    blocked,
    done,
    failed,
  };
};

export const getPlaylistStateFromStats = (stats: PlaylistStats) => {
  if (stats.total === 0) return "idle";
  if (stats.downloading > 0 || stats.pending > 0) return "running";
  if (stats.done > 0) return "completed";
  return "idle";
};

export const getCombinedActivityStats = (status: PlaylistStatus | null | undefined) => {
  const flow = status?.stats || EMPTY_PLAYLIST_STATS;
  const shared = status?.staticStats || EMPTY_PLAYLIST_STATS;
  const pending = statCount(flow.pending) + statCount(shared.pending);
  const downloading = statCount(flow.downloading) + statCount(shared.downloading);
  const blocked = statCount(flow.blocked) + statCount(shared.blocked);
  const done = statCount(flow.done) + statCount(shared.done);
  const failed = statCount(flow.failed) + statCount(shared.failed);
  return {
    pending,
    downloading,
    blocked,
    done,
    failed,
    total: pending + downloading + blocked + done + failed,
  };
};

export const hasDownloadWorkerActivity = (status: PlaylistStatus | null | undefined) => {
  if (!status) return false;
  if (status.worker?.running === true) return true;
  if (status.operationQueue?.processing === true) return true;
  const stats = getCombinedActivityStats(status);
  return stats.pending > 0 || stats.downloading > 0;
};

export const hasReviewActivity = (
  status: Pick<PlaylistStatus, "reviewCount"> | null | undefined,
) => {
  if (!status) return false;
  return statCount(status.reviewCount) > 0;
};
