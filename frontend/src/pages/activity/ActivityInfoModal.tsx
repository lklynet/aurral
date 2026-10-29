import { useId } from "react";
import { X } from "../../components/icons";
import TooltipButton from "../../components/TooltipButton";
import { useModalDialog } from "../../hooks/useModalDialog.ts";
import { formatDateTime } from "../../utils/dateTime.ts";
import { lookupLabel, type ActivityRequest } from "./activityListUtils.ts";

const text = (value: unknown) => String(value ?? "").trim();

const formatTimestamp = (value: string | number | null | undefined) => {
  if (value == null || value === "") return "";
  const raw = text(value);
  const date = new Date(/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatSource = (item: Partial<ActivityRequest>) => {
  if (item.sourceSummary) return item.sourceSummary;
  if (item.albumGrab) return text(item.actualDownloadSource) || "Unknown";
  const source = text(item.downloadSource || item.downloadClient || item.source);
  if (!source) return "";
  return source === "lidarr" ? "Lidarr" : source === "aurral" ? "Aurral" : source;
};

const formatKind = (kind: string | null | undefined) => {
  const labels: Partial<Record<string, string>> = {
    album_requested: "Album request",
    album_download: "Album download",
    track_download: "Track download",
    playlist_import: "Playlist import",
    track_reused_aurral: "Reused track",
    track_reused_lidarr: "Reused track",
  };
  return lookupLabel(labels, kind) || text(kind).replace(/[_-]+/g, " ");
};

const formatQualityState = (state: string | null | undefined) => {
  const labels: Partial<Record<string, string>> = {
    "below-floor": "Below floor",
    upgrade: "Upgrade available",
    preferred: "Preferred",
    external: "External file",
  };
  return lookupLabel(labels, state) || text(state);
};

function getRows(item: Partial<ActivityRequest>) {
  const requester = item.requestedBy?.username || item.requestedBy?.id;
  const operation = item.playlistName || item.playlistId || item.playlistType;
  const details = item.error || item.subtitle;
  const id = item.jobId || item.id;
  return [
    ["Status", item.statusLabel || item.status],
    ["Type", item.upgrade ? "Quality upgrade" : formatKind(item.kind)],
    [
      "Download method",
      item.downloadMethodLabel ||
        (item.downloadMethod === "album"
          ? "Album download"
          : item.downloadMethod === "track"
            ? "Individual track download"
            : null),
    ],
    ["Progress", item.progressLabel],
    ["Artist", item.artistName],
    ["Album", item.albumName],
    ["Track", item.trackName],
    ["Operation", operation],
    ["Source", formatSource(item)],
    ["Previous quality", item.upgrade?.fromQuality],
    ["Quality", item.qualityLabel],
    ["Quality state", formatQualityState(item.qualityState)],
    ["Requested", formatTimestamp(item.requestedAt || item.createdAt)],
    ["Completed", formatTimestamp(item.completedAt)],
    ["Requester", requester],
    ["Source file", item.sourceFilename],
    ["Release", item.releaseTitle],
    ["Details", details],
    ["Track fallback", item.albumGrab?.fallbackReason],
    ["Previous errors", item.previousErrors?.join("; ")],
    ["ID", id],
  ].filter(([, value]) => text(value));
}

export default function ActivityInfoModal({
  item,
  onClose,
}: {
  item: Partial<ActivityRequest> | null | undefined;
  onClose: () => void;
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(item),
    onClose,
  });

  if (!item) return null;

  const title = text(item.trackName || item.albumName || item.title) || "Activity details";
  const rows = getRows(item);

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="artist-modal activity-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <h2 id={titleId} className="artist-modal__title">
            {title}
          </h2>
          <TooltipButton
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            label="Close details"
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>
        <dl className="activity-info-modal__rows">
          {rows.map(([label, value]) => (
            <div className="activity-info-modal__row" key={label}>
              <dt>{label}</dt>
              <dd>{text(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
