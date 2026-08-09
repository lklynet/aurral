import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adoptDiscoverPlaylistAsFlow,
  adoptDiscoverPlaylistAsStatic,
  getDiscoverArtworkUrl,
} from "../utils/api/endpoints/discovery.js";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
} from "../utils/api/endpoints/playlists.js";
import { useSharedPlaylists } from "../hooks/useSharedPlaylists";
import { useDiscoverData } from "./useDiscoverData";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { useToast } from "../contexts/ToastContext";
import { extractTwoToneGradientFromImage } from "../utils/imageColors";
import { reserveUniquePlaylistName } from "./ArtistDetails/utils";
import { Crosshair } from "lucide-react";

import { useParams } from "react-router-dom";
import { FlowTracksPanel } from "./flows/flowComponents/flowTrackComponents.jsx";
const getPlaylistTextColor = (hex) => {
  const raw = String(hex || "").trim();
  if (raw === "#ffffff" || raw === "#fffac8" || raw === "#ffe119" || raw === "#fabed4" || raw === "#dcbeff" || raw === "#aaffc3") return "#222";
  return "#fff";
};

const getPlaylistSourceLine = (playlist) => {
  if (playlist?.type === "editorial" && playlist?.editorialType) {
    const labels = { genre: "Genre", era: "Era", mood: "Mood" };
    return labels[playlist.editorialType] || playlist.editorialType;
  }
  if (playlist?.type === "editorial") return "Editorial";
  return null;
};

const mapPlaylistTracks = (tracks, presetId) =>
  (Array.isArray(tracks) ? tracks : []).map((track, index) => {
    const artistMbid = String(track?.artistMbid || "").trim();
    const trackMbid = String(track?.trackMbid || "").trim();
    return {
      id: `${presetId}-${index}-${trackMbid || index}`,
      artistName: track?.artistName || "Unknown Artist",
      trackName: track?.trackName || "Unknown Track",
      albumName: track?.albumName || null,
      durationMs: null,
      reason: track?.reason || "Discover playlist",
      artistMbid: artistMbid || null,
      albumMbid: String(track?.albumMbid || "").trim() || null,
      trackMbid: trackMbid || null,
    };
  });

export default function DiscoverPlaylistDetailPage() {
  const { presetId } = useParams();
  const { data } = useDiscoverData();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();

  const playlist = useMemo(() => {
    const playlists = data?.discoverPlaylists || [];
    return playlists.find((p) => p.presetId === presetId) || null;
  }, [data?.discoverPlaylists, presetId]);

  const tracks = useMemo(
    () => (playlist ? mapPlaylistTracks(playlist.tracks || [], playlist.presetId) : []),
    [playlist],
  );
  const hasAlbumMetadata = useMemo(
    () => tracks.some((track) => String(track?.albumName || "").trim()),
    [tracks],
  );

  const [adoptingFlowId, setAdoptingFlowId] = useState(null);
  const [adoptingPlaylistId, setAdoptingPlaylistId] = useState(null);
  const [failedArtwork, setFailedArtwork] = useState(false);

  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading,
    playlistsError: playlistMenuError,
    setPlaylistsError: setPlaylistMenuError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  const getDefaultPlaylistName = useCallback(
    (track) => reserveUniquePlaylistName(sharedPlaylists, `${track?.artistName || "Artist"} Picks`),
    [sharedPlaylists],
  );

  const buildTrackPayload = useCallback(
    (track) => ({
      artistName: track.artistName || "",
      trackName: track.trackName || "",
      albumName: track.albumName || "",
      artistMbid: track.artistMbid || "",
      albumMbid: track.albumMbid || "",
      trackMbid: track.trackMbid || "",
      releaseYear: track.releaseYear || null,
      reason: "Discover playlist",
    }),
    [],
  );

  const handleAddTrackToPlaylist = useCallback(
    async (track, target) => {
      const payload = buildTrackPayload(track);
      setPlaylistMenuError("");
      setPlaylistMenuSavingKey(String(track?.id ?? ""));
      try {
        if (target?.mode === "new") {
          const name =
            String(target?.name || "").trim() ||
            reserveUniquePlaylistName(sharedPlaylists, `${payload.artistName} Picks`);
          const response = await createSharedPlaylist({ name, tracks: [payload] });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          await addSharedPlaylistTracks(target.playlistId, { tracks: [payload] });
          const targetPlaylist = sharedPlaylists.find((pl) => pl.id === target.playlistId);
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) setSharedPlaylists(nextPlaylists);
      } catch (error) {
        const message =
          error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "Failed to save track to playlist";
        setPlaylistMenuError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [buildTrackPayload, loadSharedPlaylists, setPlaylistMenuError, setSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const sourceLine = playlist ? getPlaylistSourceLine(playlist) : null;

  const showArtwork = playlist ? Number(playlist.trackCount) > 0 && !failedArtwork : false;
  const artworkUrl = showArtwork ? getDiscoverArtworkUrl(playlist.presetId) : null;

  const [extractedColor, setExtractedColor] = useState(null);
  const colorRequestRef = useRef(null);

  useEffect(() => {
    if (!artworkUrl) {
      setExtractedColor(null);
      return;
    }
    const url = artworkUrl;
    colorRequestRef.current = url;
    extractTwoToneGradientFromImage(url).then((result) => {
      if (colorRequestRef.current === url && result?.top) {
        setExtractedColor(result.top);
      }
    });
    return () => {
      if (colorRequestRef.current === url) {
        colorRequestRef.current = null;
      }
    };
  }, [artworkUrl]);

  const heroColor = extractedColor || playlist?.artworkColor || "#555";

  const handleNavigateArtist = useCallback(
    (track) => {
      if (!track?.artistMbid) return;
      navigate(`/artist/${track.artistMbid}`, {
        state: { artistName: track.artistName },
      });
    },
    [navigate],
  );

  const handleAdoptFlow = useCallback(
    async () => {
      if (!playlist) return;
      if (playlist.adoptedFlowId) {
        navigate(`/playlists?selected=${encodeURIComponent(playlist.adoptedFlowId)}`);
        return;
      }
      setAdoptingFlowId(playlist.presetId);
      try {
        const result = await adoptDiscoverPlaylistAsFlow(playlist.presetId);
        const flowId = result?.flowId;
        showSuccess(
          result?.alreadyAdopted
            ? `Opened ${playlist.name}`
            : `Added ${playlist.name} as a rotating flow`,
        );
        if (flowId) {
          navigate(`/playlists?selected=${encodeURIComponent(flowId)}`);
        }
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add rotating flow",
        );
      } finally {
        setAdoptingFlowId(null);
      }
    },
    [navigate, playlist, showError, showSuccess],
  );

  const handleAdoptPlaylist = useCallback(
    async () => {
      if (!playlist) return;
      if (playlist.adoptedPlaylistId) {
        navigate(`/playlists?selected=${encodeURIComponent(playlist.adoptedPlaylistId)}`);
        return;
      }
      setAdoptingPlaylistId(playlist.presetId);
      try {
        const result = await adoptDiscoverPlaylistAsStatic(playlist.presetId);
        const playlistId = result?.playlistId;
        showSuccess(
          result?.alreadyAdopted
            ? `Opened ${playlist.name}`
            : `Added ${playlist.name} as a static playlist`,
        );
        if (playlistId) {
          navigate(`/playlists?selected=${encodeURIComponent(playlistId)}`);
        }
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add static playlist",
        );
      } finally {
        setAdoptingPlaylistId(null);
      }
    },
    [navigate, playlist, showError, showSuccess],
  );

  if (!playlist) {
    return (
      <div className="discover-playlist-detail">
        <div className="arr-page__empty">
          <p>Playlist not found.</p>
        </div>
      </div>
    );
  }

  const isBusy = adoptingFlowId === playlist.presetId || adoptingPlaylistId === playlist.presetId;

  return (
    <div
      className="discover-playlist-detail"
      style={{
        background: `linear-gradient(180deg, ${heroColor} 0%, ${heroColor} 120px, var(--aurral-surface) 400px)`,
      }}
    >
      <div className="discover-playlist-detail__hero">
        <div className="discover-playlist-detail__cover">
          {showArtwork ? (
            <img
              src={getDiscoverArtworkUrl(playlist.presetId)}
              alt={playlist.name}
              loading="eager"
              onError={() => setFailedArtwork(true)}
            />
          ) : (
            <div
              className="discover-playlist-detail__cover-fallback"
              style={{ backgroundColor: heroColor }}
            >
              {playlist?.type === "editorial" ? <Crosshair className="artist-icon-xl" /> : null}
              {sourceLine && (
                <span
                  className="discover-playlist-detail__cover-label"
                  style={{ color: getPlaylistTextColor(heroColor) }}
                >
                  {sourceLine}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="discover-playlist-detail__info">
          <h1 className="release-page__title">{playlist.name}</h1>
          {sourceLine && (
            <span className="discover-playlist-detail__type-badge">{sourceLine}</span>
          )}
          {playlist.description && (
            <p className="discover-playlist-detail__description">{playlist.description}</p>
          )}
          <p className="discover-playlist-detail__meta">
            {playlist.trackCount || 0} tracks
          </p>

          <div className="discover-playlist-detail__actions">
            <button
              type="button"
              className="btn btn-surface btn-sm"
              disabled={isBusy}
              onClick={handleAdoptFlow}
            >
              {playlist.adoptedFlowId ? "Open rotating flow" : "Add as rotating flow"}
            </button>
            <button
              type="button"
              className="btn btn-surface btn-sm"
              disabled={isBusy}
              onClick={handleAdoptPlaylist}
            >
              {playlist.adoptedPlaylistId ? "Open static playlist" : "Add as static playlist"}
            </button>
          </div>
        </div>
      </div>

      <FlowTracksPanel
        tracks={tracks}
        loading={false}
        showPlaybackControls={false}
        hideAlbumColumn={!hasAlbumMetadata}
        hideStatusColumn
        emptyMessage="No tracks in this playlist."
        playlistTriggerVariant="expand"
        playlists={sharedPlaylists}
        playlistsLoading={playlistsLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistMenuError={playlistMenuError}
        getDefaultPlaylistName={getDefaultPlaylistName}
        onLoadPlaylists={loadSharedPlaylists}
        onAddTrackToPlaylist={handleAddTrackToPlaylist}
        onNavigateArtist={handleNavigateArtist}
      />
    </div>
  );
}
