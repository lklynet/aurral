const STATUS_DISPLAY = {
  queued: { label: "Queued", tone: "neutral" },
  downloading: { label: "Downloading", tone: "neutral" },
  partial: { label: "Partially available", tone: "warning" },
  complete: { label: "In library", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  blocked: { label: "Needs attention", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  missing: { label: "Missing", tone: "neutral" },
};

const ACTIVE_STATUSES = new Set(["queued", "downloading"]);
const RETRY_STATUSES = new Set(["failed", "cancelled"]);

const RECOVERY_LINKS = {
  download_source_missing: { to: "/settings/download-clients", label: "Set up a download client" },
  review_required: { to: "/activity/queue", label: "Review in Activity" },
};

const CANCEL_ACTION = { id: "cancel", label: "Cancel downloads" };
const RETRY_ACTION = { id: "retry", label: "Retry" };
const DOWNLOAD_MISSING_ACTION = { id: "retry", label: "Download missing tracks" };

const albumActions = (status, recoveryCode) => {
  if (ACTIVE_STATUSES.has(status)) return [CANCEL_ACTION];
  if (status === "missing") return [DOWNLOAD_MISSING_ACTION];
  if (RETRY_STATUSES.has(status)) return [RETRY_ACTION];
  if (status === "partial" && recoveryCode === "source_failed") return [RETRY_ACTION];
  if (status === "partial") return [DOWNLOAD_MISSING_ACTION];
  return [];
};

export const aurralAlbumStatusKey = (recordId) => `aurral:${recordId}`;

export const shouldPollAlbumStatus = (status) => ACTIVE_STATUSES.has(status);

export const shouldPollAlbumStatuses = (statuses) =>
  Object.values(statuses || {}).some((entry) => shouldPollAlbumStatus(entry?.status));

export const describeAurralAlbumStatus = ({ status, recovery } = {}) => {
  const display = STATUS_DISPLAY[status];
  if (!display) return null;
  const code = recovery?.code || null;
  return {
    status,
    label: display.label,
    tone: display.tone,
    active: shouldPollAlbumStatus(status),
    actions: albumActions(status, code),
    recovery: code
      ? { code, message: recovery.message || "", link: RECOVERY_LINKS[code] || null }
      : null,
  };
};

export const buildAurralAlbumRetryPayload = ({ album, artist } = {}) => ({
  albumMbid: album?.releaseGroupMbid || album?.mbid || "",
  albumName: album?.title || "",
  artistMbid: artist?.mbid || "",
  artistName: artist?.name || "",
  managedBy: "aurral",
});
