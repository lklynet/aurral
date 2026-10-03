import { formatDateTime } from "../../utils/dateTime.js";

export const RELEASE_RADAR_PRESET_ID = "release-radar";

export const isReleaseRadarFlow = (flow) =>
  String(flow?.discoverPresetId || "").trim() === RELEASE_RADAR_PRESET_ID;

export const isEditorialFlow = (flow) =>
  String(flow?.type || "").trim() === "editorial";

const statCount = (value) => Number(value || 0);

export const getFlowDisplayTrackCount = (flow, stats, trackListLength = 0) => {
  if (isReleaseRadarFlow(flow)) {
    const actual = Math.max(statCount(trackListLength), statCount(stats?.total));
    return actual > 0 ? actual : statCount(flow?.size);
  }
  return Math.max(statCount(flow?.size), statCount(trackListLength), statCount(stats?.total));
};

export const getStaticPlaylistTrackCount = (playlist, stats, trackListLength = 0) => {
  return Math.max(
    statCount(playlist?.trackCount),
    statCount(trackListLength),
    statCount(stats?.total),
  );
};

export const EMPTY_PLAYLIST_STATS = {
  total: 0,
  done: 0,
  pending: 0,
  downloading: 0,
  blocked: 0,
  failed: 0,
};

export const getPlaylistDownloadProgressPct = (stats, trackCount = 0) => {
  const done = statCount(stats?.done);
  const total = Math.max(
    statCount(trackCount),
    statCount(stats?.pending) + statCount(stats?.downloading) + statCount(stats?.blocked) + done + statCount(stats?.failed),
  );
  if (total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 100));
};

export const formatTrackCountLabel = (trackCount, stats) => {
  const count = statCount(trackCount);
  const trackWord = count === 1 ? "track" : "tracks";
  const base = `${count} ${trackWord}`;
  const pct = getPlaylistDownloadProgressPct(stats, count);
  if (pct === null) return base;
  return `${base} · ${pct}%`;
};

export const parseFlowTimestamp = (value) =>
  typeof value === "number" ? value : Number.parseInt(value, 10);

export const formatFlowLastRun = (lastRunAt) => {
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

export const sanitizePlaylistStats = (stats) => {
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

export const getPlaylistStateFromStats = (stats) => {
  if (stats.total === 0) return "idle";
  if (stats.downloading > 0 || stats.pending > 0) return "running";
  if (stats.done > 0) return "completed";
  return "idle";
};

export const getCombinedActivityStats = (status) => {
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

export const hasDownloadWorkerActivity = (status) => {
  if (!status) return false;
  if (status.worker?.running === true) return true;
  if (status.operationQueue?.processing === true) return true;
  const stats = getCombinedActivityStats(status);
  return stats.pending > 0 || stats.downloading > 0;
};

export const hasReviewActivity = (status) => {
  if (!status) return false;
  const stats = getCombinedActivityStats(status);
  return stats.blocked > 0;
};
