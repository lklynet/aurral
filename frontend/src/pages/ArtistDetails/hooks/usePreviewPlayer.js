import { useState, useEffect, useRef } from "react";
import { getArtistPreview } from "../../../utils/api";

const SNAP_BACK_MS = 320;
const PREVIEW_VOLUME_KEY = "aurral.preview.volume";

function getInitialPreviewVolume() {
  if (typeof window === "undefined") return 0.7;
  const stored = window.localStorage.getItem(PREVIEW_VOLUME_KEY);
  const parsed = stored == null ? NaN : Number.parseFloat(stored);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  return 0.7;
}

export function usePreviewPlayer(mbid, artistNameFromNav, artist) {
  const [previewTracks, setPreviewTracks] = useState([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [playingPreviewId, setPlayingPreviewId] = useState(null);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewSnappingBack, setPreviewSnappingBack] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(getInitialPreviewVolume);
  const previewAudioRef = useRef(null);
  const previewTickRef = useRef(null);
  const snapBackTimeoutRef = useRef(null);

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

  const finishSnapBack = () => {
    if (snapBackTimeoutRef.current) clearTimeout(snapBackTimeoutRef.current);
    snapBackTimeoutRef.current = null;
    setPlayingPreviewId(null);
    setPreviewProgress(0);
    setPreviewSnappingBack(false);
  };

  const handlePreviewPlay = (track) => {
    const audio = previewAudioRef.current;
    if (!audio || !track.preview_url) return;
    if (playingPreviewId === track.id) {
      if (audio.paused) {
        if (snapBackTimeoutRef.current)
          clearTimeout(snapBackTimeoutRef.current);
        snapBackTimeoutRef.current = null;
        setPreviewSnappingBack(false);
        audio.play();
      } else {
        audio.pause();
        if (previewTickRef.current)
          cancelAnimationFrame(previewTickRef.current);
        previewTickRef.current = null;
        setPreviewSnappingBack(true);
        setPreviewProgress(0);
        snapBackTimeoutRef.current = setTimeout(finishSnapBack, SNAP_BACK_MS);
      }
      return;
    }
    if (snapBackTimeoutRef.current) clearTimeout(snapBackTimeoutRef.current);
    snapBackTimeoutRef.current = null;
    setPreviewSnappingBack(false);
    setPlayingPreviewId(track.id);
    setPreviewProgress(0);
    if (previewTickRef.current) cancelAnimationFrame(previewTickRef.current);
    const PREVIEW_DURATION = 30;
    const tick = () => {
      if (audio.ended) {
        if (previewTickRef.current)
          cancelAnimationFrame(previewTickRef.current);
        previewTickRef.current = null;
        setPreviewSnappingBack(true);
        setPreviewProgress(0);
        snapBackTimeoutRef.current = setTimeout(finishSnapBack, SNAP_BACK_MS);
        return;
      }
      const t = audio.currentTime;
      const d = audio.duration;
      const duration = Number.isFinite(d) && d > 0 ? d : PREVIEW_DURATION;
      setPreviewProgress(Math.min(1, t / duration));
      previewTickRef.current = requestAnimationFrame(tick);
    };
    previewTickRef.current = requestAnimationFrame(tick);
    audio.src = track.preview_url;
    audio.play();
  };

  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.volume = previewVolume;
  }, [previewVolume]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PREVIEW_VOLUME_KEY, String(previewVolume));
  }, [previewVolume]);

  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    const PREVIEW_DURATION = 30;
    const updateProgress = () => {
      const t = audio.currentTime;
      const d = audio.duration;
      const duration = Number.isFinite(d) && d > 0 ? d : PREVIEW_DURATION;
      setPreviewProgress(Math.min(1, t / duration));
    };
    const onLoadedMetadata = updateProgress;
    const clearProgressTick = () => {
      if (previewTickRef.current != null) {
        cancelAnimationFrame(previewTickRef.current);
        previewTickRef.current = null;
      }
    };
    const onEnded = () => {
      clearProgressTick();
      setPreviewSnappingBack(true);
      setPreviewProgress(0);
      if (snapBackTimeoutRef.current) clearTimeout(snapBackTimeoutRef.current);
      snapBackTimeoutRef.current = setTimeout(finishSnapBack, SNAP_BACK_MS);
    };
    const onPause = () => {
      clearProgressTick();
      setPreviewSnappingBack(true);
      setPreviewProgress(0);
      if (snapBackTimeoutRef.current) clearTimeout(snapBackTimeoutRef.current);
      snapBackTimeoutRef.current = setTimeout(finishSnapBack, SNAP_BACK_MS);
    };
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    return () => {
      clearProgressTick();
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
    };
  }, [previewTracks.length]);

  return {
    previewTracks,
    setPreviewTracks,
    loadingPreview,
    setLoadingPreview,
    playingPreviewId,
    previewProgress,
    previewSnappingBack,
    previewVolume,
    setPreviewVolume,
    previewAudioRef,
    handlePreviewPlay,
  };
}
