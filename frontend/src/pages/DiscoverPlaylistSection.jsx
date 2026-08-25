import { useCallback, useMemo, useState } from "react";
import {
  adoptDiscoverPlaylistAsFlow,
  adoptDiscoverPlaylistAsStatic,
  getDiscoverArtworkUrl,
} from "../utils/api/endpoints/discovery.js";
import { useToast } from "../contexts/ToastContext";

import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { CheckCircle2, Crosshair, ListMusic, Sparkles } from "lucide-react";
import { DiscoverPlaylistContextMenu } from "../components/DiscoverPlaylistContextMenu";
import { DiscoverRail } from "../components/DiscoverRail";
import DiscoveryStatusPill from "../components/DiscoveryStatusPill";
const RECIPE_LABELS = {
  discover: "Discovery",
  mix: "Library",
  trending: "Trending",
  focus: "Focus",
  releaseRadar: "New releases",
};

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

const getPlaylistSourceLine = (playlist) => {
  const description = String(playlist?.description || "").trim();
  if (description) return description;
  return formatRecipeMeta(playlist) || "";
};

const getPlaylistCoverIcon = (playlist) => {
  if (playlist?.type === "release_radar") return Sparkles;
  if (playlist?.type === "focus") return Crosshair;
  return ListMusic;
};

const formatRecipeMeta = (playlist) => {
  const recipe = playlist?.recipe;
  if (!recipe || typeof recipe !== "object") return null;
  const parts = Object.entries(recipe)
    .map(([key, value]) => {
      const count = Number(value);
      if (!Number.isFinite(count) || count <= 0) return null;
      return `${count} ${RECIPE_LABELS[key] || key}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
};

export function DiscoverPlaylistSection({
  playlists = [],
  artworkVersion = null,
  canAdopt = false,
  playlistsUpdating = false,
  playlistsUpdateMessage = null,
  onFlowAdopted,
  onPlaylistAdopted,
}) {
  const [adoptingFlowId, setAdoptingFlowId] = useState(null);
  const [adoptingPlaylistId, setAdoptingPlaylistId] = useState(null);
  const [failedArtworkIds, setFailedArtworkIds] = useState({});
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();

  const visiblePlaylists = useMemo(() => sortDiscoverPlaylists(playlists), [playlists]);

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
        onFlowAdopted?.(playlist.presetId, flowId);
        showSuccess(
          result?.alreadyAdopted
            ? `Opened ${playlist.name}`
            : `Added ${playlist.name} as a rotating flow`,
        );
        if (flowId) {
          navigate(`/playlists?selected=${encodeURIComponent(flowId)}`);
        }
      } catch (error) {
        showError(
          error.response?.data?.message ||
            error.response?.data?.error ||
            error.message ||
            "Failed to add rotating flow",
        );
      } finally {
        setAdoptingFlowId(null);
      }
    },
    [navigate, onFlowAdopted, showError, showSuccess],
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
        onPlaylistAdopted?.(playlist.presetId, playlistId);
        showSuccess(
          result?.alreadyAdopted
            ? `Opened ${playlist.name}`
            : `Added ${playlist.name} as a static playlist`,
        );
        if (playlistId) {
          navigate(`/playlists?selected=${encodeURIComponent(playlistId)}`);
        }
      } catch (error) {
        showError(
          error.response?.data?.message ||
            error.response?.data?.error ||
            error.message ||
            "Failed to add static playlist",
        );
      } finally {
        setAdoptingPlaylistId(null);
      }
    },
    [navigate, onPlaylistAdopted, showError, showSuccess],
  );

  if (visiblePlaylists.length === 0 && !playlistsUpdating) {
    return null;
  }

  return (
    <DiscoverRail
      title="Playlists"
      onViewAll={() => navigate("/discover/playlists")}
      afterTitle={
        <DiscoveryStatusPill
          playlistsUpdating={playlistsUpdating}
          playlistsUpdateMessage={playlistsUpdateMessage}
        />
      }
    >
      <div className="discover-playlist-cards">
        {visiblePlaylists.map((playlist) => {
          const CoverIcon = getPlaylistCoverIcon(playlist);
          const sourceLine = getPlaylistSourceLine(playlist);
          const showArtwork =
            Number(playlist.trackCount) > 0 && !failedArtworkIds[playlist.presetId];

          return (
            <div key={playlist.presetId} className="artist-discover-shelf-card">
              <div
                className="artist-discover-card artist-discover-card--playlist"
              >
                <button
                  type="button"
                  className="artist-discover-card__cover"
                  aria-label={`Open ${playlist.name}`}
                  onClick={() => navigate(`/discover/playlists/${encodeURIComponent(playlist.presetId)}`)}
                >
                  {showArtwork ? (
                    <img
                      src={getDiscoverArtworkUrl(playlist.presetId, artworkVersion)}
                      alt=""
                      className="artist-discover-card__image"
                      loading="lazy"
                      onError={() =>
                        setFailedArtworkIds((current) => ({
                          ...current,
                          [playlist.presetId]: true,
                        }))
                      }
                    />
                  ) : (
                    <div className="artist-media-placeholder--discover">
                      <CoverIcon className="artist-icon-lg" aria-hidden="true" />
                    </div>
                  )}
                </button>
                <div className="artist-discover-card__content">
                  <div className="artist-discover-card__text">
                    <div className="artist-card-title-row--discover">
                      <button
                        type="button"
                        className="artist-card-title--discover"
                        title={playlist.name}
                        onClick={() => navigate(`/discover/playlists/${encodeURIComponent(playlist.presetId)}`)}
                      >
                        {playlist.name}
                      </button>
                      {playlist.adoptedFlowId ? (
                        <CheckCircle2
                          className="artist-library-check--discover"
                          title="Added as rotating flow"
                        />
                      ) : null}
                      {playlist.adoptedPlaylistId ? (
                        <CheckCircle2
                          className="artist-library-check--discover"
                          title="Added as static playlist"
                        />
                      ) : null}
                    </div>
                    {sourceLine ? (
                      <p className="artist-card-meta--discover" title={sourceLine}>
                        {sourceLine}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <DiscoverPlaylistContextMenu
                      playlist={playlist}
                      canAdopt={canAdopt}
                      adoptingFlowId={adoptingFlowId}
                      adoptingPlaylistId={adoptingPlaylistId}
                      onAdoptFlow={handleAdoptFlow}
                      onAdoptPlaylist={handleAdoptPlaylist}
                      triggerVariant="icon"
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </DiscoverRail>
  );
}
