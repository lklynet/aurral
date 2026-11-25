import { useQuery } from "@tanstack/react-query";
import LibraryInfoModal from "../pages/LibraryInfoModal";
import { libraryViewQueryOptions } from "../utils/libraryViewQuery.ts";
import type { QueueEntry } from "../utils/audioQueue";

export type PlayerInfoState = {
  entry: QueueEntry;
} | null;

function useLibraryTrack(entry: QueueEntry | null) {
  const albumId =
    entry?.libraryTrackId != null && entry.libraryAlbumId != null
      ? String(entry.libraryAlbumId)
      : null;
  const options = libraryViewQueryOptions({ albumId: albumId ?? "none" });
  const { data } = useQuery({ ...options, enabled: albumId !== null });
  const track =
    albumId === null || data?.isPreview
      ? undefined
      : data?.library?.tracks.find(
          (candidate) => String(candidate.id) === String(entry?.libraryTrackId),
        );
  return { track, library: data?.library };
}

export default function PlayerInfoDialog({
  info,
  onClose,
}: {
  info: PlayerInfoState;
  onClose: () => void;
}) {
  const entry = info?.entry ?? null;
  const { track, library } = useLibraryTrack(entry);

  return (
    <LibraryInfoModal
      item={
        entry
          ? {
              kind: "track",
              source: "player",
              entity: track ?? {
                id: entry.libraryTrackId ?? null,
                available: true,
                title: entry.title,
                artistName: entry.artist,
                albumName: entry.album,
                streamFormat: entry.streamFormat,
                quality: typeof entry.quality === "string" ? null : entry.quality,
                durationMs: entry.durationMs,
                mbid: entry.trackMbid,
              },
              album: track
                ? library?.albums.find((candidate) => candidate.id === entry.libraryAlbumId)
                : undefined,
              artist: track
                ? library?.artists.find((candidate) => candidate.id === entry.libraryArtistId)
                : undefined,
              trackNumber: track?.albums?.find(
                (candidate) => String(candidate.albumId) === String(entry.libraryAlbumId),
              )?.trackNumber,
            }
          : null
      }
      onClose={onClose}
    />
  );
}
