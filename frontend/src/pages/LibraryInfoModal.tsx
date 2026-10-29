import { useId } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { X } from "../components/icons";
import TooltipButton from "../components/TooltipButton";
import { useAuth } from "../contexts/AuthContext";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { libraryTracksClient } from "../utils/api/clients/libraryTracks.ts";
import { playlistJobsClient } from "../utils/api/clients/playlistJobs.ts";
import type { LibraryAlbum, LibraryArtist, LibraryTrack } from "../utils/libraryPageData.ts";

type LibraryQuality = NonNullable<LibraryTrack["files"][number]["quality"]>;
type LibraryMetadata = {
  genres?: unknown;
  genre?: unknown;
  common?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  durationMs?: unknown;
  duration?: unknown;
  albumType?: unknown;
  releaseType?: unknown;
};

interface LibraryInfoEntity {
  id?: string | number | null;
  title?: string | null;
  trackName?: string | null;
  albumName?: string | null;
  name?: string | null;
  artistName?: string | null;
  albumArtist?: string | null;
  sortName?: string | null;
  albumIds?: number[];
  statistics?: { albumCount?: number; trackCount?: number; trackFileCount?: number } | null;
  releaseDate?: string | null;
  trackCount?: number;
  trackIds?: number[];
  availableTrackCount?: number;
  files?: LibraryTrack["files"];
  durationMs?: number | null;
  metadata?: LibraryMetadata | null;
  streamFormat?: string | null;
  quality?: LibraryQuality | string | null;
  qualityTier?: string | null;
  qualityLabel?: string | null;
  status?: string;
  available?: boolean;
  sources?: string[];
  downloadSource?: string | null;
  mbid?: string | null;
  trackMbid?: string | null;
  releaseGroupMbid?: string | null;
}
type LibraryInfoItem = {
  kind: "artist" | "album" | "track";
  source?: string | null;
  entity: LibraryInfoEntity;
  artist?: LibraryArtist | null;
  album?: LibraryAlbum | null;
  trackNumber?: number | null;
};

const text = (value: unknown) => String(value ?? "").trim();

const formatList = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .map(text)
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(", ");

const metadataGenres = (entity: LibraryInfoEntity | null | undefined) => {
  const metadata = entity?.metadata || {};
  return formatList([
    ...(Array.isArray(metadata.genres) ? metadata.genres : [metadata.genres]),
    ...(Array.isArray(metadata.genre) ? metadata.genre : [metadata.genre]),
    ...(Array.isArray(metadata.common?.genre) ? metadata.common.genre : [metadata.common?.genre]),
    ...(Array.isArray(metadata.tags?.genre) ? metadata.tags.genre : [metadata.tags?.genre]),
  ]);
};

const firstFile = (track: LibraryInfoEntity | null | undefined) =>
  (track?.files || []).find((file) => file.available) || track?.files?.[0];

const durationMs = (
  track: LibraryInfoEntity,
  file: LibraryTrack["files"][number] | null | undefined,
) => {
  if (Number(file?.durationMs) > 0) return Number(file?.durationMs);
  if (Number(track?.durationMs) > 0) return Number(track.durationMs);
  if (Number(track?.metadata?.durationMs) > 0) return Number(track.metadata?.durationMs);
  const seconds = Number(track?.metadata?.duration);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
};

const formatDuration = (duration: number | null | undefined) => {
  const seconds = Math.floor(Number(duration || 0) / 1000);
  return seconds ? Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") : "";
};

const formatQuality = (quality: LibraryQuality | string | null | undefined) => {
  if (!quality || typeof quality !== "object") return text(quality);
  return [
    quality.bitrate ? quality.bitrate + " kbps" : "",
    quality.bitsPerSample ? quality.bitsPerSample + " bit" : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

const getRows = ({ kind, source, entity, artist, album, trackNumber }: LibraryInfoItem) => {
  const isPlaylistTrack = source === "playlist";
  const file = kind === "track" ? firstFile(entity) : null;
  const title =
    entity?.title || entity?.trackName || entity?.albumName || entity?.name || entity?.artistName;
  const rows: [string, unknown][] = [
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
      ["Artist", entity.artistName || artist?.name],
      ["Album", album?.title || entity.albumName],
      ["Track number", trackNumber],
      ["Duration", formatDuration(durationMs(entity, file))],
      ["Format", file?.format || entity.streamFormat],
      [
        "Quality",
        formatQuality(file?.quality || entity.quality) ||
          (entity.qualityTier && entity.qualityLabel),
      ],
      [
        "Available",
        (isPlaylistTrack ? entity.status === "done" : (entity.available ?? file?.available))
          ? "Yes"
          : "No",
      ],
    );
  }

  rows.push(
    ["Genres", metadataGenres(entity)],
    ["Sources", formatList(entity.sources || entity.downloadSource)],
    ["MusicBrainz ID", entity.mbid || entity.trackMbid],
    ...(kind === "album"
      ? [["Release group ID", entity.releaseGroupMbid] satisfies [string, unknown]]
      : []),
    [isPlaylistTrack ? "Job ID" : "Library ID", entity.id],
  );
  return rows.filter(([, value]) => text(value));
};

const pathsLabel = (
  query: UseQueryResult<
    InferResponseType<(typeof libraryTracksClient.tracks)[":id"]["files"]["$get"], 200>
  >,
) => {
  if (query.isPending) return "Loading…";
  if (query.isError) return "Could not load file paths";
  return query.data?.paths?.length ? query.data.paths : "No file on disk";
};

export default function LibraryInfoModal({
  item,
  onClose,
}: {
  item: LibraryInfoItem | null | undefined;
  onClose: () => void;
}) {
  const titleId = useId();
  const { user } = useAuth();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: Boolean(item),
    onClose,
  });
  const trackId = item?.kind === "track" ? item.entity?.id : null;
  const showPaths = Boolean(trackId) && user?.role === "admin";
  const pathsQuery = useQuery({
    queryKey: ["track-files", item?.source || "library", trackId],
    queryFn: ({ signal }) =>
      item?.source === "playlist"
        ? parseResponse(
            playlistJobsClient.jobs[":jobId"].files.$get(
              { param: { jobId: encodeURIComponent(String(trackId)) } },
              { init: { signal } },
            ),
          )
        : parseResponse(
            libraryTracksClient.tracks[":id"].files.$get(
              { param: { id: encodeURIComponent(trackId!) } },
              { init: { signal } },
            ),
          ),
    enabled: showPaths,
    staleTime: 30_000,
  });

  if (!item) return null;

  const title =
    text(
      item.entity?.title || item.entity?.trackName || item.entity?.albumName || item.entity?.name,
    ) || "Library information";
  const rows = getRows(item);
  if (showPaths) {
    const paths = pathsLabel(pathsQuery);
    rows.push([Array.isArray(paths) && paths.length > 1 ? "Files" : "File", paths]);
  }

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
            <h2 id={titleId} className="artist-modal__title">
              {title}
            </h2>
            <p className="activity-info-modal__subtitle">
              {item.kind === "artist" ? "Artist" : item.kind === "album" ? "Album" : "Track"}
            </p>
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
              <dd>
                {Array.isArray(value)
                  ? value.map((entry) => <div key={entry}>{entry}</div>)
                  : text(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
