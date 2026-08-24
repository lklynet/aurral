import { formatDateTime } from "../../utils/dateTime.js";

export const RELEASE_RADAR_PRESET_ID = "release-radar";

export const isReleaseRadarFlow = (flow) =>
  String(flow?.discoverPresetId || "").trim() === RELEASE_RADAR_PRESET_ID;

export const isEditorialFlow = (flow) =>
  String(flow?.type || "").trim() === "editorial";

const flowNumber = (value) => Number(value || 0);

export const getFlowDisplayTrackCount = (flow, stats, trackListLength = 0) => {
  if (isReleaseRadarFlow(flow)) {
    const actual = Math.max(flowNumber(trackListLength), flowNumber(stats?.total));
    return actual > 0 ? actual : flowNumber(flow?.size);
  }
  return Math.max(flowNumber(flow?.size), flowNumber(trackListLength), flowNumber(stats?.total));
};

export const getSharedPlaylistTrackCount = (playlist, stats, trackListLength = 0) => {
  return Math.max(
    flowNumber(playlist?.trackCount),
    flowNumber(trackListLength),
    flowNumber(stats?.total),
  );
};

export const EMPTY_FLOW_STATS = {
  total: 0,
  done: 0,
  pending: 0,
  downloading: 0,
  blocked: 0,
  failed: 0,
};

export const getPlaylistDownloadProgressPct = (stats, trackCount = 0) => {
  const done = flowNumber(stats?.done);
  const total = Math.max(
    flowNumber(trackCount),
    flowNumber(stats?.pending) + flowNumber(stats?.downloading) + flowNumber(stats?.blocked) + done + flowNumber(stats?.failed),
  );
  if (total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 100));
};

export const formatTrackCountLabel = (trackCount, stats) => {
  const count = flowNumber(trackCount);
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

export const sanitizeFlowStats = (stats) => {
  const pending = flowNumber(stats?.pending);
  const downloading = flowNumber(stats?.downloading);
  const blocked = flowNumber(stats?.blocked);
  const done = flowNumber(stats?.done);
  const failed = flowNumber(stats?.failed);
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
  const flow = status?.stats || EMPTY_FLOW_STATS;
  const shared = status?.sharedStats || EMPTY_FLOW_STATS;
  const pending = flowNumber(flow.pending) + flowNumber(shared.pending);
  const downloading = flowNumber(flow.downloading) + flowNumber(shared.downloading);
  const blocked = flowNumber(flow.blocked) + flowNumber(shared.blocked);
  const done = flowNumber(flow.done) + flowNumber(shared.done);
  const failed = flowNumber(flow.failed) + flowNumber(shared.failed);
  return {
    pending,
    downloading,
    blocked,
    done,
    failed,
    total: pending + downloading + blocked + done + failed,
  };
};

export const hasFlowWorkerActivity = (status) => {
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
