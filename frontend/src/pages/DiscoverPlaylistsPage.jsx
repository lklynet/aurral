import { useCallback, useMemo, useState } from "react";
import {
  adoptDiscoverPlaylistAsFlow,
  adoptDiscoverPlaylistAsStatic,
  getDiscoverArtworkUrl,
} from "../utils/api/endpoints/discovery.js";
import { useToast } from "../contexts/ToastContext";
import { useAuth } from "../contexts/AuthContext";
import { Crosshair, Music } from "lucide-react";
import { DotLoader } from "../components/DotLoader";

import { Link } from "react-router-dom";
import { useDiscoverData } from "./useDiscoverData";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { DiscoverPlaylistContextMenu } from "../components/DiscoverPlaylistContextMenu";
import DiscoveryStatusPill from "../components/DiscoveryStatusPill";
const DISCOVER_FLOW_PRESET_ORDER = [
  "discover-weekly",
  "trending-mix",
  "library-blend",
  "focus-listening-history",
  "release-radar",
];

const sortDiscoverPlaylists = (playlists) => {
  const list = Array.isArray(playlists) ? [...playlists] : [];
  return list.sort((left, right) => {
    const leftIndex = DISCOVER_FLOW_PRESET_ORDER.indexOf(left?.presetId);
    const rightIndex = DISCOVER_FLOW_PRESET_ORDER.indexOf(right?.presetId);
    const leftOrder = leftIndex >= 0 ? leftIndex : DISCOVER_FLOW_PRESET_ORDER.length;
    const rightOrder = rightIndex >= 0 ? rightIndex : DISCOVER_FLOW_PRESET_ORDER.length;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
};

const PLAYLIST_COVER_ICONS = { editorial: Crosshair };

const getPlaylistCoverIcon = (playlist) => {
  if (playlist?.type === "editorial") return PLAYLIST_COVER_ICONS.editorial;
  return null;
};

const getPlaylistTextColor = (playlist) => {
  const hex = String(playlist?.artworkColor || "").trim();
  if (hex === "#ffffff" || hex === "#fffac8") return "#222";
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

export default function DiscoverPlaylistsPage() {
  const { data, error } = useDiscoverData();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();
  const { bootstrap } = useAuth();
  const lastfmConfigured = bootstrap?.lastfmConfigured === true;

  const isUpdating = data?.isUpdating || false;
  const playlistsUpdating = data?.playlistsUpdating || false;
  const updateProgressMessage = data?.updateProgressMessage;
  const playlistsUpdateMessage = data?.playlistsUpdateMessage;
  const lastUpdated = data?.lastUpdated;
  const isDiscoveryLoading = !data && !error;

  const visiblePlaylists = useMemo(
    () => sortDiscoverPlaylists(data?.discoverPlaylists || []),
    [data?.discoverPlaylists],
  );

  const [adoptingFlowId, setAdoptingFlowId] = useState(null);
  const [adoptingPlaylistId, setAdoptingPlaylistId] = useState(null);
  const [failedArtworkIds, setFailedArtworkIds] = useState({});

  const handleAdoptFlow = useCallback(
    async (playlist) => {
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
    [navigate, showError, showSuccess],
  );

  const handleAdoptPlaylist = useCallback(
    async (playlist) => {
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
    [navigate, showError, showSuccess],
  );

  if (visiblePlaylists.length === 0) {
    return (
      <div className="discover-playlists-page">
        <header className="discover-playlists-page__header">
          <div className="discover-playlists-page__title-row">
            <h1 className="page-title">Playlists</h1>
            <DiscoveryStatusPill
              isUpdating={isUpdating}
              playlistsUpdating={playlistsUpdating}
              lastUpdated={lastUpdated}
              updateProgressMessage={updateProgressMessage}
              playlistsUpdateMessage={playlistsUpdateMessage}
            />
          </div>
        </header>
        {isDiscoveryLoading ? (
          <div className="search-empty-panel discover-playlists-page__status-panel">
            <DotLoader size="lg" label={null} />
            <h2 className="search-empty-panel__title">Loading your playlists</h2>
          </div>
        ) : isUpdating || playlistsUpdating ? (
          <div className="search-empty-panel">
            <DotLoader size="lg" label={null} />
            <h2 className="search-empty-panel__title">
              {playlistsUpdating ? "Building playlists" : "Refreshing discovery"}
            </h2>
            <p className="search-empty-panel__message">
              {playlistsUpdating
                ? playlistsUpdateMessage || "Building playlists..."
                : updateProgressMessage || "Refreshing discovery..."}
            </p>
          </div>
        ) : error ? (
          <div className="search-empty-panel">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Music className="artist-icon-lg" />
            </div>
            <h2 className="search-empty-panel__title">Something went wrong</h2>
            <p className="search-empty-panel__message">{error}</p>
          </div>
        ) : !lastfmConfigured ? (
          <div className="search-empty-panel">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Music className="artist-icon-lg" />
            </div>
            <h2 className="search-empty-panel__title">Connect Last.fm</h2>
            <Link to="/settings/connect" className="btn btn-secondary btn-sm">
              Open Last.fm settings
            </Link>
          </div>
        ) : (
          <div className="search-empty-panel">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Music className="artist-icon-lg" />
            </div>
            <h2 className="search-empty-panel__title">No playlists yet</h2>
            <Link to="/settings/discover" className="btn btn-secondary btn-sm">
              Open Discovery Settings
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="discover-playlists-page">
      <header className="discover-playlists-page__header">
        <div className="discover-playlists-page__title-row">
          <h1 className="page-title">Playlists</h1>
          <DiscoveryStatusPill
            isUpdating={isUpdating}
            playlistsUpdating={playlistsUpdating}
            lastUpdated={lastUpdated}
            updateProgressMessage={updateProgressMessage}
            playlistsUpdateMessage={playlistsUpdateMessage}
          />
        </div>
        <p className="page-subtitle">{visiblePlaylists.length} playlists</p>
      </header>

      <div className="artist-albums-grid">
        {visiblePlaylists.map((playlist) => {
          const CoverIcon = getPlaylistCoverIcon(playlist);
          const sourceLine = getPlaylistSourceLine(playlist);
          const showArtwork =
            Number(playlist.trackCount) > 0 && !failedArtworkIds[playlist.presetId];

          return (
            <article
              key={playlist.presetId}
              className="artist-release-card"
            >
              <button
                type="button"
                className="artist-release-card__cover discover-playlists-page__cover-link"
                aria-label={`Open ${playlist.name}`}
                onClick={() => navigate(`/discover/playlists/${encodeURIComponent(playlist.presetId)}`)}
              >
                {showArtwork ? (
                  <img
                    src={getDiscoverArtworkUrl(playlist.presetId)}
                    alt=""
                    loading="lazy"
                    onError={() =>
                      setFailedArtworkIds((current) => ({
                        ...current,
                        [playlist.presetId]: true,
                      }))
                    }
                  />
                ) : (
                  <div
                    className="artist-release-card__placeholder"
                    style={{ backgroundColor: playlist.artworkColor || "#555" }}
                  >
                    {CoverIcon && <CoverIcon className="artist-icon-lg" />}
                    {sourceLine && (
                      <span
                        className="discover-playlists-page__cover-label"
                        style={{ color: getPlaylistTextColor(playlist) }}
                      >
                        {sourceLine}
                      </span>
                    )}
                  </div>
                )}
              </button>

              <h2 className="discover-playlists-page__card-title" title={playlist.name}>
                <button
                  type="button"
                  className="discover-playlists-page__title-link"
                  onClick={() => navigate(`/discover/playlists/${encodeURIComponent(playlist.presetId)}`)}
                >
                  {playlist.name}
                </button>
              </h2>

              <div className="artist-release-card__meta-row">
                <div className="artist-release-card__meta-col">
                  {playlist.description && (
                    <p className="artist-release-card__meta artist-truncate">{playlist.description}</p>
                  )}
                  <p className="artist-release-card__meta">{playlist.trackCount || 0} tracks</p>
                </div>
                <div>
                  <DiscoverPlaylistContextMenu
                    playlist={playlist}
                    canAdopt
                    adoptingFlowId={adoptingFlowId}
                    adoptingPlaylistId={adoptingPlaylistId}
                    onAdoptFlow={handleAdoptFlow}
                    onAdoptPlaylist={handleAdoptPlaylist}
                    triggerVariant="icon"
                  />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
