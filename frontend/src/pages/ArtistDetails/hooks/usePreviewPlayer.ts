import { useState, useEffect, useCallback } from "react";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import {
  getArtistPreview,
  type ArtistDetailsResponse,
} from "../../../utils/api/endpoints/artists.ts";
import { normalizePreviewTrack } from "../../../utils/audioQueue";
import type { deezerGetArtistTopTracksById } from "../../../../../backend/services/apiClients/index.ts";

type DeezerPreviewTrack = Awaited<ReturnType<typeof deezerGetArtistTopTracksById>>[number];
type MetadataTopTrack = ArtistDetailsResponse["topTracks"][number];
export type ArtistPreviewTrack = (DeezerPreviewTrack | MetadataTopTrack) & {
  albumMbid?: string | null;
  trackMbid?: string | null;
};

export function usePreviewPlayer(
  mbid: string | undefined,
  artistNameFromNav: string | null | undefined,
  artist: { name?: string | null } | null | undefined,
  {
    initialTracks,
    loadingDetails = false,
  }: { initialTracks?: MetadataTopTrack[]; loadingDetails?: boolean } = {},
) {
  const [previewTracks, setPreviewTracks] = useState<ArtistPreviewTrack[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [buildingQueue, setBuildingQueue] = useState(false);
  const {
    playQueue,
    playTrack,
    togglePlayPause,
    matchesSource,
    isPlaying,
    isLoading,
    currentTrack,
  } = useAudioQueue();

  const artistName = artistNameFromNav || artist?.name || "";
  const artistSource = mbid ? { type: "artist-all", id: mbid, label: artistName } : null;
  const isArtistQueue = matchesSource(artistSource);
  const playingPreviewId = isArtistQueue && currentTrack?.id ? currentTrack.id : null;
  const isArtistPlaybackActive = isArtistQueue && (isPlaying || isLoading);

  useEffect(() => {
    if (!mbid) {
      setPreviewTracks([]);
      setLoadingPreview(false);
      return;
    }
    if (loadingDetails) {
      setLoadingPreview(true);
      return;
    }
    if (initialTracks && initialTracks.length > 0) {
      setPreviewTracks(initialTracks);
      setLoadingPreview(false);
      return;
    }
    const name = artistName;
    if (!name || name === "Loading artist" || name === "Unknown Artist") {
      setPreviewTracks([]);
      setLoadingPreview(false);
      return;
    }
    const controller = new AbortController();
    setLoadingPreview(true);
    getArtistPreview(mbid, name, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setPreviewTracks(data.tracks || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewTracks([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPreview(false);
      });
    return () => controller.abort();
  }, [mbid, artistName, initialTracks, loadingDetails]);

  const getPlayableTracks = useCallback(
    () => previewTracks.filter((track) => track?.preview_url),
    [previewTracks],
  );

  const handlePreviewPlay = (track: ArtistPreviewTrack) => {
    if (!track?.preview_url) return;

    const normalized = normalizePreviewTrack(track, artistName, { artistMbid: mbid });
    if (String(playingPreviewId) === String(normalized.id)) {
      togglePlayPause();
      return;
    }

    playTrack(normalized, {
      source: artistSource,
      queue: getPlayableTracks().map((entry) =>
        normalizePreviewTrack(entry, artistName, { artistMbid: mbid }),
      ),
    });
  };

  const handlePreviewPlayAll = async () => {
    if (buildingQueue) return;

    if (isArtistQueue) {
      togglePlayPause();
      return;
    }

    setBuildingQueue(true);
    try {
      const tracks = getPlayableTracks().map((track) =>
        normalizePreviewTrack(track, artistName, { artistMbid: mbid }),
      );
      if (tracks.length === 0) return;
      playQueue(tracks, { source: artistSource });
    } finally {
      setBuildingQueue(false);
    }
  };

  const handlePreviewShuffle = () => {
    const tracks = getPlayableTracks().map((track) =>
      normalizePreviewTrack(track, artistName, { artistMbid: mbid }),
    );
    if (tracks.length > 0) playQueue(tracks, { source: artistSource, shuffle: true });
  };

  return {
    previewTracks,
    setPreviewTracks,
    loadingPreview,
    buildingQueue,
    setLoadingPreview,
    playingPreviewId,
    isArtistPlaybackActive,
    handlePreviewPlay,
    handlePreviewPlayAll,
    handlePreviewShuffle,
    canPlayPreviews: previewTracks.some((track) => track?.preview_url),
  };
}
