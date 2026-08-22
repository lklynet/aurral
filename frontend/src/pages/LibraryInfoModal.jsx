import { useId } from "react";
import { X } from "lucide-react";
import TooltipButton from "../components/TooltipButton";
import { useModalDialog } from "../hooks/useModalDialog.js";

const text = (value) => String(value ?? "").trim();

const formatList = (value) =>
  (Array.isArray(value) ? value : [value])
    .map(text)
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(", ");

const metadataGenres = (entity) => {
  const metadata = entity?.metadata || {};
  return formatList([
    ...(Array.isArray(metadata.genres) ? metadata.genres : [metadata.genres]),
    ...(Array.isArray(metadata.genre) ? metadata.genre : [metadata.genre]),
    ...(Array.isArray(metadata.common?.genre) ? metadata.common.genre : [metadata.common?.genre]),
    ...(Array.isArray(metadata.tags?.genre) ? metadata.tags.genre : [metadata.tags?.genre]),
  ]);
};

const firstFile = (track) =>
  (track?.files || []).find((file) => file.available) || track?.files?.[0];

const durationMs = (track, file) => {
  if (Number(file?.durationMs) > 0) return Number(file.durationMs);
  if (Number(track?.durationMs) > 0) return Number(track.durationMs);
  if (Number(track?.metadata?.durationMs) > 0) return Number(track.metadata.durationMs);
  const seconds = Number(track?.metadata?.duration);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
};

const formatDuration = (duration) => {
  const seconds = Math.floor(Number(duration || 0) / 1000);
  return seconds
    ? Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
    : "";
};

const formatQuality = (quality) => {
  if (!quality || typeof quality !== "object") return text(quality);
  return [
    quality.bitrate ? quality.bitrate + " kbps" : "",
    quality.bitDepth ? quality.bitDepth + " bit" : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

const getRows = ({ kind, entity, artist, album, trackNumber }) => {
  const file = kind === "track" ? firstFile(entity) : null;
  const title =
    entity?.title || entity?.trackName || entity?.albumName || entity?.name || entity?.artistName;
  const rows = [
    ["Type", kind === "artist" ? "Artist" : kind === "album" ? "Album" : "Track"],
    [kind === "artist" ? "Name" : kind === "album" ? "Album" : "Track", title],
  ];

  if (kind === "artist") {
    rows.push(
      ["Sort name", entity.sortName],
      ["Albums", entity.albumIds?.length ?? entity.statistics?.albumCount],
      ["Tracks", entity.statistics?.trackCount],
    );
  }
  if (kind === "album") {
    rows.push(
      ["Artist", artist?.name || entity.artistName || entity.albumArtist],
      ["Release date", entity.releaseDate],
      ["Tracks", entity.trackCount ?? entity.statistics?.trackCount ?? entity.trackIds?.length],
      ["Available tracks", entity.availableTrackCount ?? entity.statistics?.trackFileCount],
    );
  }
  if (kind === "track") {
    rows.push(
      ["Artist", artist?.name || entity.artistName],
      ["Album", album?.title || entity.albumName],
      ["Track number", trackNumber],
      ["Duration", formatDuration(durationMs(entity, file))],
      ["Format", file?.format || entity.streamFormat],
      ["Quality", formatQuality(file?.quality || entity.quality)],
      ["Available", (entity.available ?? file?.available) ? "Yes" : "No"],
    );
  }

  rows.push(
    ["Genres", metadataGenres(entity)],
    ["Sources", formatList(entity.sources)],
    ["MusicBrainz ID", entity.mbid],
    ...(kind === "album" ? [["Release group ID", entity.releaseGroupMbid]] : []),
    ["Library ID", entity.id],
  );
  return rows.filter(([, value]) => text(value));
};

export default function LibraryInfoModal({ item, onClose }) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(item),
    onClose,
  });

  if (!item) return null;

  const title =
    text(item.entity?.title || item.entity?.trackName || item.entity?.albumName || item.entity?.name) ||
    "Library information";
  const rows = getRows(item);

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="artist-modal activity-info-modal library-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <div>
            <p className="activity-info-modal__eyebrow">
              {item.kind === "artist" ? "Artist" : item.kind === "album" ? "Album" : "Track"} information
            </p>
            <h2 id={titleId} className="artist-modal__title">{title}</h2>
          </div>
          <TooltipButton
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            label="Close information"
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
