import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adoptDiscoverPlaylistAsFlow,
  adoptDiscoverPlaylistAsStatic,
  getDiscoverArtworkUrl,
  getDiscoverPlaylistPreviews,
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
import { ArrowLeft, Crosshair } from "lucide-react";

import { Link, useParams } from "react-router-dom";
import { FlowTracksPanel } from "./flows/flowComponents/flowTrackComponents.jsx";
import { DotLoader } from "../components/DotLoader";
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
      durationMs: track?.durationMs || null,
      reason: track?.reason || "Discover playlist",
      artistMbid: artistMbid || null,
      albumMbid: String(track?.albumMbid || "").trim() || null,
      trackMbid: trackMbid || null,
      status: track?.preview_url ? "done" : "pending",
      streamUrl: track?.preview_url || null,
    };
  });

export default function DiscoverPlaylistDetailPage() {
  const { presetId } = useParams();
  const { data, error } = useDiscoverData();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();

  const playlist = useMemo(() => {
    const playlists = data?.discoverPlaylists || [];
    return playlists.find((p) => p.presetId === presetId) || null;
  }, [data?.discoverPlaylists, presetId]);

  const [previewTracks, setPreviewTracks] = useState(null);
  const [previewMessage, setPreviewMessage] = useState("");

  useEffect(() => {
    setPreviewTracks(null);
    setPreviewMessage("");
    if (playlist?.type !== "editorial") return undefined;
    const controller = new AbortController();
    getDiscoverPlaylistPreviews(playlist.presetId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const nextTracks = result?.tracks || [];
        setPreviewTracks(nextTracks);
        if (!nextTracks.some((track) => track?.preview_url)) {
          setPreviewMessage("No Deezer previews are available for this playlist.");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreviewTracks(null);
          setPreviewMessage("Deezer previews are unavailable right now.");
        }
      });
    return () => controller.abort();
  }, [playlist?.presetId, playlist?.type]);

  const tracks = useMemo(
    () => (playlist ? mapPlaylistTracks(previewTracks || playlist.tracks || [], playlist.presetId) : []),
    [playlist, previewTracks],
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

  if (!data && !error) {
    return (
      <div className="discover-playlist-detail">
        <section className="discover-playlist-detail__status" aria-live="polite">
          <DotLoader size="lg" label={null} />
          <h1>Loading playlist</h1>
        </section>
      </div>
    );
  }

  if (error && !playlist) {
    return (
      <div className="discover-playlist-detail">
        <section className="discover-playlist-detail__status" role="alert">
          <h1>Unable to load playlist</h1>
          <p>{error}</p>
          <Link className="btn btn-secondary btn-sm" to="/discover/playlists">
            Back to playlists
          </Link>
        </section>
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="discover-playlist-detail">
        <section className="discover-playlist-detail__status">
          <h1>Playlist not found</h1>
          <p>This discovery playlist is no longer available.</p>
          <Link className="btn btn-secondary btn-sm" to="/discover/playlists">
            Back to playlists
          </Link>
        </section>
      </div>
    );
  }

  const isBusy = adoptingFlowId === playlist.presetId || adoptingPlaylistId === playlist.presetId;

  return (
    <div
      className="discover-playlist-detail"
      style={{ "--discover-playlist-hero-color": heroColor }}
    >
      <Link className="discover-playlist-detail__back" to="/discover/playlists">
        <ArrowLeft aria-hidden="true" />
        Back to playlists
      </Link>
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
              {playlist?.type === "editorial" ? (
                <Crosshair className="artist-icon-xl" aria-hidden="true" />
              ) : null}
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

      {previewMessage ? (
        <p className="flow-page__tracks-error" role="status">{previewMessage}</p>
      ) : null}
      <FlowTracksPanel
        tracks={tracks}
        loading={false}
        playbackSource={{
          type: "discover-playlist-preview",
          id: playlist.presetId,
          label: playlist.name,
          recordHistory: false,
        }}
        showPlaybackControls={playlist.type === "editorial"}
        hideAlbumColumn={!hasAlbumMetadata}
        hideStatusColumn
        hideQualityColumn
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
