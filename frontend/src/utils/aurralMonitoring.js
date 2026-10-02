import { shouldPollAlbumStatus } from "./aurralAlbumStatus.js";
import { getMonitorOptionsForManager, normalizeLibraryManager } from "./libraryDestination.js";

export const MONITOR_OPTIONS = [
  { value: "none", label: "None (artist only)" },
  { value: "existing", label: "Existing albums" },
  { value: "all", label: "All albums" },
  { value: "future", label: "Future albums" },
  { value: "missing", label: "Missing albums" },
  { value: "latest", label: "Latest album" },
  { value: "first", label: "First album" },
];

export const getMonitorOptionLabel = (value) =>
  MONITOR_OPTIONS.find((option) => option.value === value)?.label || value;

export const resolveCurrentMonitorOption = (artist, managedBy) => {
  if (!artist || artist.monitored === false) return "none";
  const stored = artist.monitorOption || artist.addOptions?.monitor || artist.monitorNewItems;
  if (!stored) return artist.monitored ? "all" : "none";
  const offered = getMonitorOptionsForManager(MONITOR_OPTIONS, managedBy);
  return offered.some((option) => option.value === stored) ? stored : null;
};

const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const SKIPPED_DETAILS = [
  { reason: "complete", text: (count) => `${count} already in your library` },
  {
    reason: "unmonitored",
    text: (count) =>
      `${count} skipped because you unmonitored ${count === 1 ? "it" : "them"}`,
  },
  { reason: "managed_by_lidarr", text: (count) => `${count} managed by Lidarr` },
];

const summaryHeadline = ({ mode, releaseGroupIds = [], queued }) => {
  if (queued) return `Queued ${plural(releaseGroupIds.length, "album")} for download`;
  if (mode === "none") return "Monitoring turned off";
  if (mode === "future") return "Watching for new releases";
  return "No albums to queue";
};

export const summarizeAurralMonitoring = (monitoring) => {
  const plan = monitoring || {};
  const counts = new Map();
  for (const entry of plan.skipped || []) {
    counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
  }
  const details = SKIPPED_DETAILS.filter(({ reason }) => counts.has(reason)).map(
    ({ reason, text }) => text(counts.get(reason)),
  );
  const knownReasons = new Set(SKIPPED_DETAILS.map(({ reason }) => reason));
  const otherCount = [...counts]
    .filter(([reason]) => !knownReasons.has(reason))
    .reduce((total, [, count]) => total + count, 0);
  if (otherCount > 0) details.push(`${otherCount} skipped`);
  const headline = summaryHeadline(plan);
  return { headline, details, message: [headline, ...details].join(". ") };
};

export const describeArtistMonitoringResult = (response) => {
  if (!response?.monitoring) return null;
  return {
    patch: { monitored: response.monitored, monitorOption: response.monitorOption },
    message: summarizeAurralMonitoring(response.monitoring).message,
  };
};

const METADATA_UNAVAILABLE_MESSAGE =
  "Couldn't load this artist's releases from the metadata service, so monitoring was not changed. Try again in a moment.";

export const describeAurralMonitoringError = (
  error,
  fallback = "Failed to update artist monitoring",
) => {
  const data = error?.response?.data || {};
  if (error?.response?.status === 503 && data.code === "metadata_unavailable") {
    return METADATA_UNAVAILABLE_MESSAGE;
  }
  return data.message || data.error || error?.message || fallback;
};

export const getAlbumMonitoredState = (album) => {
  if (normalizeLibraryManager(album?.managedBy) !== "aurral") return null;
  const monitored = album.monitored ?? album.metadata?.monitored;
  return monitored === true && album.monitorMode !== "unmonitored";
};

export const getMonitoringMenuAction = ({ monitored, hasMissing }) => {
  if (monitored) return "stop";
  return hasMissing ? null : "monitor";
};

export const canDownloadAurralAlbum = (album, { hasMissingTracks }) =>
  getAlbumMonitoredState(album) === false &&
  hasMissingTracks &&
  Boolean(album.mbid || album.releaseGroupMbid);

export const shouldConfirmUnmonitor = (status) =>
  status == null || shouldPollAlbumStatus(status);

const describeMonitoringResult = (result, subject) => {
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

export const describeAlbumMonitoringResult = (result) => describeMonitoringResult(result, "Album");

export const describeTrackMonitoringResult = (result) => describeMonitoringResult(result, "Track");
