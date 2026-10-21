import type { MonitoringRules } from "../components/MonitoringRulesFields.tsx";
import { shouldPollAlbumStatus, type AlbumStatus } from "./aurralAlbumStatus.ts";
import { normalizeLibraryManager } from "./libraryDestination.ts";
import { describeDownloadCount, plural } from "./monitoringRules.ts";

export interface AurralMonitoringPlan {
  queued?: boolean;
  releaseGroupIds?: string[];
  topTracks?: unknown[];
  skipped?: { reason: string }[];
  topTracksError?: string | null;
}

interface AurralMonitoringState {
  monitored?: boolean;
  rules?: MonitoringRules | null;
}

export interface AurralAlbumMonitoredRef {
  managedBy?: string | null;
  monitored?: boolean | null;
  monitorMode?: string | null;
  metadata?: { monitored?: boolean | null } | null;
  releaseGroupMbid?: string | null;
  mbid?: string | null;
}

interface MonitoringResult {
  monitored?: boolean;
  cancelledJobIds?: string[];
  cleanupFailed?: boolean;
}

interface KeepFileResult {
  keepFile?: boolean;
  cancelledJobIds?: string[];
  cleanupFailed?: boolean;
}

export const MONITOR_OPTIONS = [
  { value: "none", label: "None (artist only)" },
  { value: "existing", label: "Existing albums" },
  { value: "all", label: "All albums" },
  { value: "future", label: "Future albums" },
  { value: "missing", label: "Missing albums" },
  { value: "latest", label: "Latest album" },
  { value: "first", label: "First album" },
];

export const getMonitorOptionLabel = (value: string) =>
  MONITOR_OPTIONS.find((option) => option.value === value)?.label || value;

const SKIPPED_DETAILS: { reason: string; text: (count: number) => string }[] = [
  { reason: "complete", text: (count) => `${count} already in your library` },
  {
    reason: "covered",
    text: (count) =>
      `${count} skipped because another release has ${count === 1 ? "its" : "their"} songs`,
  },
  {
    reason: "excluded",
    text: (count) => `${count} skipped because you removed ${count === 1 ? "it" : "them"}`,
  },
  {
    reason: "unmonitored",
    text: (count) => `${count} skipped because you unmonitored ${count === 1 ? "it" : "them"}`,
  },
  { reason: "managed_by_lidarr", text: (count) => `${count} managed by Lidarr` },
  { reason: "metadata_unavailable", text: (count) => `${count} could not be checked` },
];

const summaryHeadline = (
  plan: AurralMonitoringPlan,
  { monitored, rules }: AurralMonitoringState = {},
) => {
  if (monitored === false) return "Monitoring turned off";
  const downloads = describeDownloadCount({
    releases: plan.releaseGroupIds?.length || 0,
    tracks: plan.topTracks?.length || 0,
  });
  if (plan.queued && downloads) return `Queued ${downloads} for download`;
  if (rules?.newReleases) return "Watching for new releases";
  return "Nothing new to download";
};

export const summarizeAurralMonitoring = (
  monitoring: AurralMonitoringPlan | null | undefined,
  state: AurralMonitoringState = {},
) => {
  const plan: AurralMonitoringPlan = monitoring || {};
  const counts = new Map<string, number>();
  for (const entry of plan.skipped || []) {
    counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
  }
  const details = SKIPPED_DETAILS.filter(({ reason }) => counts.has(reason)).map(
    ({ reason, text }) => text(counts.get(reason)!),
  );
  const knownReasons = new Set(SKIPPED_DETAILS.map(({ reason }) => reason));
  const otherCount = [...counts]
    .filter(([reason]) => !knownReasons.has(reason))
    .reduce((total, [, count]) => total + count, 0);
  if (otherCount > 0) details.push(`${otherCount} skipped`);
  if (plan.topTracksError) details.push(plan.topTracksError.replace(/\.$/, ""));
  const headline = summaryHeadline(plan, state);
  return { headline, details, message: [headline, ...details].join(". ") };
};

const METADATA_UNAVAILABLE_MESSAGE =
  "Couldn't load this artist's releases from the metadata service, so monitoring was not changed. Try again in a moment.";

export const describeAurralMonitoringError = (
  error: unknown,
  fallback = "Failed to update artist monitoring",
) => {
  const data = error?.response?.data || {};
  if (error?.response?.status === 503 && data.code === "metadata_unavailable") {
    return METADATA_UNAVAILABLE_MESSAGE;
  }
  return data.message || data.error || error?.message || fallback;
};

export const getAlbumMonitoredState = (album: AurralAlbumMonitoredRef | null) => {
  if (normalizeLibraryManager(album?.managedBy) !== "aurral") return null;
  const monitored = album!.monitored ?? album!.metadata?.monitored;
  return monitored === true && album!.monitorMode !== "unmonitored";
};

export const getMonitoringMenuAction = ({
  monitored,
  hasMissing,
}: {
  monitored?: boolean | null;
  hasMissing?: boolean | null;
}) => {
  if (monitored) return "stop";
  return hasMissing ? null : "monitor";
};

export const canDownloadAurralAlbum = (
  album: AurralAlbumMonitoredRef,
  { hasMissingTracks }: { hasMissingTracks: boolean },
) =>
  getAlbumMonitoredState(album) === false &&
  hasMissingTracks &&
  Boolean(album.releaseGroupMbid || album.mbid);

export const shouldConfirmUnmonitor = (status: AlbumStatus | null | undefined) =>
  status == null || shouldPollAlbumStatus(status);

const describeMonitoringResult = (result: MonitoringResult | null | undefined, subject: string) => {
  if (result?.monitored !== false) return { message: `${subject} monitored`, warning: false };
  const cancelled = result.cancelledJobIds?.length || 0;
  if (result.cleanupFailed) {
    return {
      message: `${subject} unmonitored. Cancelled ${plural(cancelled, "download")}, but the download client may still hold the work.`,
      warning: true,
    };
  }
  if (cancelled > 0) {
    return {
      message: `${subject} unmonitored. Cancelled ${plural(cancelled, "download")}.`,
      warning: false,
    };
  }
  return { message: `${subject} unmonitored`, warning: false };
};

export const describeAlbumMonitoringResult = (result: MonitoringResult | null | undefined) =>
  describeMonitoringResult(result, "Album");

export const describeTrackMonitoringResult = (result: MonitoringResult | null | undefined) =>
  describeMonitoringResult(result, "Track");

export const describeKeepFileResult = (
  result: KeepFileResult | null | undefined,
  title: string,
) => {
  if (!result?.keepFile) return { message: `Aurral can upgrade ${title} again.`, warning: false };
  const kept = `Keeping ${title}. Aurral won't replace it with an upgrade`;
  if (result.cleanupFailed) {
    return {
      message: `${kept}, but the download client may still hold the upgrade in progress.`,
      warning: true,
    };
  }
  return {
    message: result.cancelledJobIds?.length
      ? `${kept}, and the upgrade in progress was cancelled.`
      : `${kept}.`,
    warning: false,
  };
};
