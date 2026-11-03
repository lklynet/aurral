import { useMemo, useState } from "react";
import ArtworkImage from "../../components/ArtworkImage";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { clearLibraryPageCache } from "../../utils/api/endpoints/library.ts";
import { EMPTY_LIBRARY } from "../../utils/libraryPageData.ts";
import { libraryPreviewData, libraryPreviewFavorites } from "../libraryPreviewData";
import type { LibraryViewData } from "../libraryViewQuery.ts";
import type { WebSocketChannelMessage } from "../../../../backend/services/websocketService.ts";
import type { LibraryAlbum, LibraryArtist, LibraryTrack } from "../../utils/libraryPageData.ts";

export type LibraryPageTrack = LibraryTrack & {
  durationMs?: number | null;
  albumName?: string | null;
};

export type LibraryEntityByKind = {
  artist: LibraryArtist;
  album: LibraryAlbum;
  track: LibraryPageTrack;
};

export type LibraryTarget = {
  [Kind in keyof LibraryEntityByKind]: { kind: Kind; entity: LibraryEntityByKind[Kind] };
}[keyof LibraryEntityByKind];

export type LibraryRemoval = LibraryTarget & { manager?: string | null };

export type TrackDownloadState = { jobId: string | null; status: string };

export const text = (value: unknown) => String(value || "").trim();

export const isAlbumArtistCredit = (
  track: LibraryTrack,
  artist: LibraryArtist | null | undefined,
) =>
  !text(track?.artistName) ||
  text(track.artistName).toLowerCase() === text(artist?.name).toLowerCase();

export const trackDurationMs = (track: LibraryPageTrack) => {
  const fileDurationMs = (track?.files || []).find(
    (file) => Number(file?.durationMs) > 0,
  )?.durationMs;
  if (fileDurationMs != null) return fileDurationMs;
  if (Number(track?.durationMs) > 0) return track.durationMs;
  const metadataDurationMs = Number(track?.metadata?.durationMs);
  if (metadataDurationMs > 0) return metadataDurationMs;
  const metadataDurationSeconds = Number(track?.metadata?.duration);
  return metadataDurationSeconds > 0 ? Math.round(metadataDurationSeconds * 1000) : null;
};

export const formatDuration = (durationMs: number | null | undefined) => {
  const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  if (!seconds) return "";
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};

export const TRACK_DOWNLOAD_ACTIVE_STATUSES = new Set([
  "submitting",
  "pending",
  "processing",
  "searching",
  "downloading",
  "moving",
  "blocked",
  "completed",
]);

export const TRACK_DOWNLOAD_ACTION_LABELS: Partial<Record<string, string>> = {
  submitting: "Adding to search queue…",
  pending: "Queued for search",
  processing: "Searching for track…",
  searching: "Searching for track…",
  downloading: "Downloading track…",
  moving: "Adding to library…",
  blocked: "Needs review",
  completed: "Downloaded; waiting for library refresh",
  failed: "Retry download track",
};

export const trackDownloadActionLabel = (status: string | null | undefined) =>
  TRACK_DOWNLOAD_ACTION_LABELS[status ?? ""] || "Download track";

export const activityDownloadStatus = (
  request: { status?: string; statusLabel?: unknown } | null | undefined,
) => {
  if (request?.status === "failed") return "failed";
  if (request?.status === "cancelled") return "cancelled";
  if (request?.status === "completed" || request?.status === "unchanged") return "completed";
  if (request?.status === "blocked") return "blocked";
  const label = text(request?.statusLabel).toLocaleLowerCase();
  if (label.includes("download")) return "downloading";
  if (label.includes("moving")) return "moving";
  if (request?.status === "pending") return "pending";
  return "searching";
};

export const trackDownloadIdentity = (track: LibraryPageTrack, fallbackTitle = "") =>
  String(track?.id || track?.mbid || track?.title || fallbackTitle);

export const sameTrackText = (left: unknown, right: unknown) => {
  const first = text(left).toLocaleLowerCase();
  const second = text(right).toLocaleLowerCase();
  return Boolean(first) && Boolean(second) && first === second;
};

export const hasMbid = (
  artist: LibraryArtist | null | undefined,
): artist is LibraryArtist & { mbid: string } => Boolean(artist?.mbid);

export function Cover({
  src,
  label,
  round = false,
  compact = false,
  thumbnail = true,
  onError,
}: {
  src?: string | null;
  label?: string | null;
  round?: boolean;
  compact?: boolean;
  thumbnail?: boolean;
  onError?: () => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && src !== failedSrc) {
    return (
      <ArtworkImage
        src={src}
        thumbnail={thumbnail}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => {
          setFailedSrc(src);
          onError?.();
        }}
      />
    );
  }

  return (
    <span
      className={
        "native-library-cover-fallback" +
        (round ? " is-round" : "") +
        (compact ? " is-compact" : "")
      }
      role="img"
      aria-label={label || "Unknown artwork"}
    >
      {text(label).slice(0, 1).toUpperCase() || "—"}
    </span>
  );
}

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="native-library-state">
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

export const invalidateLibraryViews = () => {
  clearLibraryPageCache();
  void queryClient.invalidateQueries({
    queryKey: queryKeys.libraryAlbumTracksPrefix,
    refetchType: "none",
  });
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix }),
    queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix }),
  ]);
};

const handleLibraryScanMessage = (message: WebSocketChannelMessage) => {
  if (message?.type === "library_scan_completed") void invalidateLibraryViews();
};

export const useLibraryScanRefresh = () => useWebSocketChannel("library", handleLibraryScanMessage);

export function useLibraryViewData(data: LibraryViewData | undefined, forcePreview: boolean) {
  const isPreviewLibrary = forcePreview || data?.isPreview === true;
  const library = data?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
  const favoriteIds = useMemo(
    () =>
      data?.favoriteIds ||
      (isPreviewLibrary ? new Set(libraryPreviewFavorites) : new Set<string>()),
    [isPreviewLibrary, data?.favoriteIds],
  );
  return { isPreviewLibrary, library, favoriteIds };
}
