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

export type AlbumStatus = keyof typeof STATUS_DISPLAY;

const isAlbumStatus = (status: string): status is AlbumStatus =>
  Object.hasOwn(STATUS_DISPLAY, status);

const ACTIVE_STATUSES = new Set<string | null | undefined>(["queued", "downloading"]);
const RETRY_STATUSES = new Set<string | null | undefined>(["failed", "cancelled"]);

type RecoveryCode = "download_source_missing" | "review_required" | "source_failed";

type RecoveryLink = { label: string } & ({ to: string } | { settings: string });

const RECOVERY_LINKS: Partial<Record<RecoveryCode, RecoveryLink>> = {
  download_source_missing: { settings: "downloads", label: "Set up a download client" },
  review_required: { to: "/activity/queue", label: "Review in Activity" },
};

interface AlbumRecovery {
  code: RecoveryCode;
  message?: string;
}

interface AlbumStatusEntry {
  status?: string | null;
  recovery?: AlbumRecovery | null;
}

const CANCEL_ACTION = { id: "cancel", label: "Cancel downloads" };
const RETRY_ACTION = { id: "retry", label: "Retry" };
const DOWNLOAD_MISSING_ACTION = { id: "retry", label: "Download missing tracks" };

const albumActions = (status: string | null | undefined, recoveryCode: RecoveryCode | null) => {
  if (ACTIVE_STATUSES.has(status)) return [CANCEL_ACTION];
  if (status === "missing") return [DOWNLOAD_MISSING_ACTION];
  if (RETRY_STATUSES.has(status)) return [RETRY_ACTION];
  if (status === "partial" && recoveryCode === "source_failed") return [RETRY_ACTION];
  if (status === "partial") return [DOWNLOAD_MISSING_ACTION];
  return [];
};

export const aurralAlbumStatusKey = (canonicalId: string | number) => `aurral:${canonicalId}`;

export const shouldPollAlbumStatus = (status: string | null | undefined) =>
  ACTIVE_STATUSES.has(status);

export const shouldPollAlbumStatuses = (
  statuses: Record<string, AlbumStatusEntry | undefined> | null | undefined,
) => Object.values(statuses || {}).some((entry) => shouldPollAlbumStatus(entry?.status));

export const describeAurralAlbumStatus = ({ status, recovery }: AlbumStatusEntry = {}) => {
  if (!status || !isAlbumStatus(status)) return null;
  const display = STATUS_DISPLAY[status];
  const code = recovery?.code || null;
  return {
    status,
    label: display.label,
    tone: display.tone,
    active: shouldPollAlbumStatus(status),
    actions: albumActions(status, code),
    recovery: code
      ? { code, message: recovery!.message || "", link: RECOVERY_LINKS[code] || null }
      : null,
  };
};

export const buildAurralAlbumRetryPayload = ({
  album,
  artist,
}: {
  album?: { releaseGroupMbid?: string | null; mbid?: string | null; title?: string | null };
  artist?: { mbid?: string | null; name?: string | null } | null;
} = {}) => ({
  albumMbid: album?.releaseGroupMbid || album?.mbid || "",
  albumName: album?.title || "",
  artistMbid: artist?.mbid || "",
  artistName: artist?.name || "",
  managedBy: "aurral",
});
