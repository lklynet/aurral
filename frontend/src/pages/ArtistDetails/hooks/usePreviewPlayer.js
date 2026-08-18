import { useState, useEffect, useCallback } from "react";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { getArtistPreview } from "../../../utils/api/endpoints/artists.js";
import { normalizePreviewTrack } from "../../../utils/audioQueue";

export function usePreviewPlayer(mbid, artistNameFromNav, artist) {
  const [previewTracks, setPreviewTracks] = useState([]);
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
    isShuffleEnabled,
  } = useAudioQueue();

  const artistName = artistNameFromNav || artist?.name || "";
  const artistSource = mbid ? { type: "artist-all", id: mbid, label: artistName } : null;
  const isArtistQueue = matchesSource(artistSource);
  const playingPreviewId = isArtistQueue && currentTrack?.id ? currentTrack.id : null;
  const isArtistPlaybackActive = isArtistQueue && (isPlaying || isLoading);

  useEffect(() => {
    const name = artistName;
    if (!mbid || !name || name === "Loading artist" || name === "Unknown Artist") {
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
  }, [mbid, artistName]);

  const getPlayableTracks = useCallback(
    () => previewTracks.filter((track) => track?.preview_url),
    [previewTracks],
  );

  const handlePreviewPlay = (track) => {
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
      playQueue(tracks, {
        source: artistSource,
        shuffle: isShuffleEnabled,
        updateShufflePreference: false,
      });
    } finally {
      setBuildingQueue(false);
    }
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
  };
}
