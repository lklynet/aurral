import { useId } from "react";
import { X } from "lucide-react";
import TooltipButton from "../../components/TooltipButton";
import { useModalDialog } from "../../hooks/useModalDialog.js";
import { formatDateTime } from "../../utils/dateTime.js";

const text = (value) => String(value ?? "").trim();

const formatTimestamp = (value) => {
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

const formatSource = (item) => {
  const source = text(item.downloadSource || item.downloadClient || item.source);
  if (!source) return "";
  return source === "lidarr" ? "Lidarr" : source === "aurral" ? "Aurral" : source;
};

const formatKind = (kind) => {
  const labels = {
    album_requested: "Album request",
    track_download: "Track download",
    playlist_import: "Playlist import",
    track_reused_aurral: "Reused track",
    track_reused_lidarr: "Reused track",
  };
  return labels[kind] || text(kind).replace(/[_-]+/g, " ");
};

const formatQualityState = (state) => {
  const labels = {
    "below-floor": "Below floor",
    upgrade: "Upgrade available",
    preferred: "Preferred",
    external: "External file",
  };
  return labels[state] || text(state);
};

function getRows(item) {
  const requester = item.requestedBy?.username || item.requestedBy?.id;
  const operation = item.playlistName || item.playlistId || item.playlistType;
  const details = item.error || item.subtitle;
  const id = item.jobId || item.id;
  return [
    ["Status", item.statusLabel || item.status],
    ["Type", formatKind(item.kind)],
    ["Artist", item.artistName],
    ["Album", item.albumName],
    ["Track", item.trackName],
    ["Operation", operation],
    ["Source", formatSource(item)],
    ["Quality", item.qualityLabel],
    ["Quality state", formatQualityState(item.qualityState)],
    ["Requested", formatTimestamp(item.requestedAt || item.createdAt)],
    ["Requester", requester],
    ["Source file", item.sourceFilename],
    ["Details", details],
    ["ID", id],
  ].filter(([, value]) => text(value));
}

export default function ActivityInfoModal({ item, onClose }) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(item),
    onClose,
  });

  if (!item) return null;

  const title = text(item.trackName || item.albumName || item.title) || "Activity details";
  const status = text(item.statusLabel || item.status);
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
          <div>
            {status ? <p className="activity-info-modal__eyebrow">{status}</p> : null}
            <h2 id={titleId} className="artist-modal__title">{title}</h2>
          </div>
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
