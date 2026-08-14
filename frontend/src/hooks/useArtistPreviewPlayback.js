import { useCallback, useMemo, useState } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { getArtistPreview } from "../utils/api/endpoints/artists.js";
import { getLibraryArtist, getLibraryAlbums, getLibraryTracks } from "../utils/api/endpoints/library.js";
import { isDownloadedLibraryAlbum, normalizePreviewTrack, normalizeQueueTrack } from "../utils/audioQueue";

export function useArtistPreviewPlayback({ mbid, artistName, enabled = true, isInLibrary = false } = {}) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const { playQueue, togglePlayPause, matchesSource, isPlaying, isLoading } = useAudioQueue();

  const source = useMemo(
    () =>
      mbid
        ? {
            type: "artist-preview",
            id: mbid,
            label: artistName || "Artist preview",
          }
        : null,
    [artistName, mbid],
  );
  const canPlayArtistPreview = enabled && Boolean(mbid && artistName);
  const isArtistPreviewSource = matchesSource(source);
  const isArtistPreviewActive = isArtistPreviewSource && (isPlaying || isLoading);

  const playArtistPreview = useCallback(async () => {
    if (!canPlayArtistPreview || isLoadingPreview) return false;
    if (isArtistPreviewSource) {
      togglePlayPause();
      return true;
    }

    setIsLoadingPreview(true);
    try {
      if (isInLibrary) {
        const libraryArtist = await getLibraryArtist(mbid);
        if (libraryArtist?.id) {
          const albums = await getLibraryAlbums(libraryArtist.id);
          const downloaded = (Array.isArray(albums) ? albums : []).filter((album) =>
            isDownloadedLibraryAlbum(album),
          );
          if (downloaded.length > 0) {
            const queue = [];
            const seen = new Set();
            for (const album of downloaded) {
              const tracks = await getLibraryTracks(album.id, album.mbid || album.foreignAlbumId, {
                artistName,
                albumTitle: album.title,
                readPath: "canonical",
              });
              for (const track of Array.isArray(tracks) ? tracks : []) {
                if (!track?.preview_url || !track?.streamPath) continue;
                const key = track.id ?? track.mbid ?? `lib-${album.id}-${track.trackNumber}`;
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push(
                  normalizeQueueTrack({
                    id: key,
                    title: track.title || track.trackName,
                    artist: artistName,
                    album: album.title,
                    src: track.preview_url,
                    streamFormat: track.streamFormat,
                    quality: track.quality,
                    artistMbid: mbid,
                    albumMbid: album.mbid || album.foreignAlbumId || "",
                  }),
                );
              }
            }
            if (queue.length > 0) {
              return playQueue(queue, {
                source,
                shuffle: false,
                updateShufflePreference: false,
              });
            }
          }
        }
      }

      const data = await getArtistPreview(mbid, artistName);
      const tracks = (Array.isArray(data?.tracks) ? data.tracks : [])
        .filter((track) => track?.preview_url)
        .map((track) => normalizePreviewTrack(track, artistName, { artistMbid: mbid }));
      if (tracks.length === 0) return false;
      return playQueue(tracks, {
        source,
        shuffle: false,
        updateShufflePreference: false,
      });
    } finally {
      setIsLoadingPreview(false);
    }
  }, [
    artistName,
    canPlayArtistPreview,
    isArtistPreviewSource,
    isLoadingPreview,
    isInLibrary,
    mbid,
    playQueue,
    source,
    togglePlayPause,
  ]);

  return {
    canPlayArtistPreview,
    isArtistPreviewActive,
    isLoadingPreview,
    playArtistPreview,
  };
}
