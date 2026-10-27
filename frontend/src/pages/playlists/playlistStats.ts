import type { InferResponseType } from "hono/client";
import type { playlistJobsClient } from "../../utils/api/clients/playlistJobs.ts";
import { formatDateTime } from "../../utils/dateTime.ts";

type PlaylistStatusSnapshot = InferResponseType<typeof playlistJobsClient.status.$get, 200>;

export interface FlowMix {
  discover: number;
  mix: number;
  trending: number;
  focus: number;
}

export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  type: string | null;
  discoverPresetId: string | null;
  size: number;
  mix: FlowMix;
  tags: string[];
  relatedArtists: string[];
  deepDive: boolean;
  recordHistory: boolean;
  yearFrom: number | null;
  yearTo: number | null;
  scheduleDays: number[];
  scheduleTime: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  ownerUserId: number | null;
  ownerUsername: string | null;
  showInLibrary: boolean;
}

export type PlaylistStats = PlaylistStatusSnapshot["stats"];

export interface StaticPlaylist {
  id: string;
  name: string;
  ownerUserId: number | null;
  ownerUsername: string | null;
  sourceName: string | null;
  sourceFlowId: string | null;
  trackCount: number;
  recordHistory: boolean;
  showTrackAvailability: boolean;
  importSource: {
    provider: string;
    syncEnabled: boolean;
    syncIntervalHours: number;
    keepRemovedTracks: boolean;
  } | null;
  trackEntries: { id: string; identity: string }[];
  trackIdentities: string[];
}

export type PlaylistStatus = Omit<PlaylistStatusSnapshot, "flows" | "sharedPlaylists"> & {
  flows: Flow[];
  sharedPlaylists: StaticPlaylist[];
};

export const RELEASE_RADAR_PRESET_ID = "release-radar";

export const isReleaseRadarFlow = (flow: Partial<Flow> | null | undefined) =>
  String(flow?.discoverPresetId || "").trim() === RELEASE_RADAR_PRESET_ID;

export const isEditorialFlow = (flow: Partial<Flow> | null | undefined) =>
  String(flow?.type || "").trim() === "editorial";

const statCount = (value: number | null | undefined) => Number(value || 0);

export const getFlowDisplayTrackCount = (
  flow: Partial<Flow> | null | undefined,
  stats: PlaylistStats | null | undefined,
  trackListLength = 0,
) => {
  if (isReleaseRadarFlow(flow)) {
    const actual = Math.max(statCount(trackListLength), statCount(stats?.total));
    return actual > 0 ? actual : statCount(flow?.size);
  }
  return Math.max(statCount(flow?.size), statCount(trackListLength), statCount(stats?.total));
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

export const getPlaylistDownloadProgressPct = (
  stats: PlaylistStats | null | undefined,
  trackCount = 0,
) => {
  const done = statCount(stats?.done);
  const total = Math.max(
    statCount(trackCount),
    statCount(stats?.pending) +
      statCount(stats?.downloading) +
      statCount(stats?.blocked) +
      done +
      statCount(stats?.failed),
  );
  if (total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 100));
};

export const formatTrackCountLabel = (
  trackCount: number,
  stats: PlaylistStats | null | undefined,
) => {
  const count = statCount(trackCount);
  const trackWord = count === 1 ? "track" : "tracks";
  const base = `${count} ${trackWord}`;
  const pct = getPlaylistDownloadProgressPct(stats, count);
  if (pct === null) return base;
  return `${base} · ${pct}%`;
};

export const parseFlowTimestamp = (value: number | string | null | undefined) =>
  typeof value === "number" ? value : Number.parseInt(String(value), 10);

export const formatFlowLastRun = (lastRunAt: number | null | undefined) => {
  const timestamp = parseFlowTimestamp(lastRunAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTime(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

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
  const shared = status?.sharedStats || EMPTY_PLAYLIST_STATS;
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
