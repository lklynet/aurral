import { useState, useEffect, useCallback } from "react";
import { useAudioQueue } from "../../../hooks/useAudioQueue";
import { getArtistPreview } from "../../../utils/api";
import { buildArtistPlaybackQueue } from "../../../utils/buildArtistPlaybackQueue";
import { normalizePreviewTrack } from "../../../utils/audioQueue";

export function usePreviewPlayer(
  mbid,
  artistNameFromNav,
  artist,
  {
    existsInLibrary = false,
    libraryArtist = null,
    libraryAlbums = [],
    downloadStatuses = {},
    albumTracks = {},
  } = {},
) {
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
  const releaseGroups = artist?.["release-groups"] || [];
  const artistSource = mbid
    ? { type: "artist-all", id: mbid, label: artistName }
    : null;
  const isArtistQueue = matchesSource(artistSource);
  const playingPreviewId =
    isArtistQueue && currentTrack?.id ? currentTrack.id : null;
  const isArtistPlaybackActive = isArtistQueue && (isPlaying || isLoading);

  useEffect(() => {
    const name = artistNameFromNav || artist?.name;
    if (!mbid || !name) {
      if (!artistNameFromNav && !artist) setPreviewTracks([]);
      return;
    }
    setLoadingPreview(true);
    getArtistPreview(mbid, name)
      .then((data) => setPreviewTracks(data.tracks || []))
      .catch(() => setPreviewTracks([]))
      .finally(() => setLoadingPreview(false));
  }, [mbid, artistNameFromNav, artist]);

  const getPlayableTracks = useCallback(
    () => previewTracks.filter((track) => track?.preview_url),
    [previewTracks],
  );

  const handlePreviewPlay = (track) => {
    if (!track?.preview_url) return;

    const normalized = normalizePreviewTrack(track, artistName);
    if (String(playingPreviewId) === String(normalized.id)) {
      togglePlayPause();
      return;
    }

    playTrack(normalized, {
      source: artistSource,
      queue: getPlayableTracks().map((entry) =>
        normalizePreviewTrack(entry, artistName),
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
      const tracks = await buildArtistPlaybackQueue({
        artistName,
        artistMbid: mbid,
        previewTracks: getPlayableTracks(),
        existsInLibrary,
        libraryArtist,
        libraryAlbums,
        downloadStatuses,
        albumTracksCache: albumTracks,
        releaseGroups,
      });
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
