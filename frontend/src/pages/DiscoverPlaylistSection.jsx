import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Crosshair,
  ListMusic,
  Loader,
  Sparkles,
} from "lucide-react";
import { DiscoverPlaylistContextMenu } from "../components/DiscoverPlaylistContextMenu";
import { DiscoverRail } from "../components/DiscoverRail";
import { FlowTracksPanel } from "./FlowPageComponents";
import {
  adoptDiscoverPlaylistAsFlow,
  adoptDiscoverPlaylistAsStatic,
  addSharedPlaylistTracks,
  createSharedPlaylist,
  getDiscoverArtworkUrl,
  getFlowStatus,
} from "../utils/api";
import { useToast } from "../contexts/ToastContext";

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
    const leftOrder =
      leftIndex >= 0 ? leftIndex : DISCOVER_FLOW_PRESET_ORDER.length;
    const rightOrder =
      rightIndex >= 0 ? rightIndex : DISCOVER_FLOW_PRESET_ORDER.length;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
};

const reserveUniquePlaylistName = (playlists, baseName = "Playlist") => {
  const names = new Set(
    (Array.isArray(playlists) ? playlists : []).map((playlist) =>
      String(playlist?.name || "")
        .trim()
        .toLowerCase(),
    ),
  );
  const base = String(baseName || "Playlist").trim() || "Playlist";
  if (!names.has(base.toLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${base} ${index}`;
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

const mapPlaylistTracks = (tracks = [], presetId = "") =>
  tracks.map((track, index) => ({
    id: `${presetId}-${track.artistName || "artist"}-${track.trackName || "track"}-${index}`,
    trackName: track.trackName || "Unknown Track",
    artistName: track.artistName || "Unknown Artist",
    artistMbid: track.artistMbid || null,
    albumMbid: track.albumMbid || null,
    trackMbid: track.trackMbid || null,
    releaseYear: track.releaseYear || null,
  }));

const buildTrackPayload = (track) => ({
  artistName: track.artistName || "",
  trackName: track.trackName || "",
  albumName: track.albumName || "",
  artistMbid: track.artistMbid || "",
  albumMbid: track.albumMbid || "",
  trackMbid: track.trackMbid || "",
  releaseYear: track.releaseYear || null,
  reason: "Discover playlist",
});

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
  const [expandedId, setExpandedId] = useState(null);
  const [adoptingFlowId, setAdoptingFlowId] = useState(null);
  const [adoptingPlaylistId, setAdoptingPlaylistId] = useState(null);
  const [failedArtworkIds, setFailedArtworkIds] = useState({});
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [playlistMenuError, setPlaylistMenuError] = useState("");
  const expandedPanelRef = useRef(null);
  const playlistCardsRef = useRef(null);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const visiblePlaylists = useMemo(
    () => sortDiscoverPlaylists(playlists),
    [playlists],
  );

  const expandedPlaylist = visiblePlaylists.find(
    (playlist) => playlist.presetId === expandedId,
  );

  const expandedTracks = useMemo(() => {
    if (!expandedPlaylist) return [];
    return mapPlaylistTracks(
      expandedPlaylist.tracks || [],
      expandedPlaylist.presetId,
    );
  }, [expandedPlaylist]);

  const handleToggle = useCallback((presetId) => {
    setExpandedId((current) => (current === presetId ? null : presetId));
  }, []);

  useEffect(() => {
    if (!expandedId) return undefined;

    const handlePointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (expandedPanelRef.current?.contains(target)) return;
      if (playlistCardsRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(".artist-options-menu--discover")
      ) {
        return;
      }
      setExpandedId(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expandedId]);

  const loadPlaylistsForMenu = useCallback(async () => {
    setPlaylistsLoading(true);
    setPlaylistMenuError("");
    try {
      const data = await getFlowStatus();
      const nextPlaylists = Array.isArray(data?.sharedPlaylists)
        ? data.sharedPlaylists
        : [];
      setSharedPlaylists(nextPlaylists);
      return nextPlaylists;
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to load playlists";
      setPlaylistMenuError(message);
      showError(message);
      return null;
    } finally {
      setPlaylistsLoading(false);
    }
  }, [showError]);

  const getDefaultPlaylistName = useCallback(
    (track) =>
      reserveUniquePlaylistName(
        sharedPlaylists,
        `${track?.artistName || "Artist"} Picks`,
      ),
    [sharedPlaylists],
  );

  const handleAddTrackToPlaylist = useCallback(
    async (track, target) => {
      const payload = buildTrackPayload(track);
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return;
      }
      setPlaylistMenuError("");
      setPlaylistMenuSavingKey(String(track?.id ?? ""));
      try {
        if (target?.mode === "new") {
          const name =
            String(target?.name || "").trim() ||
            reserveUniquePlaylistName(
              sharedPlaylists,
              `${payload.artistName} Picks`,
            );
          const response = await createSharedPlaylist({
            name,
            tracks: [payload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = sharedPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target.playlistId, {
            tracks: [payload],
          });
          showSuccess(
            `Track added to ${targetPlaylist?.name || "playlist"}`,
          );
        }
        const nextPlaylists = await loadPlaylistsForMenu();
        if (nextPlaylists) {
          setSharedPlaylists(nextPlaylists);
        }
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
    [loadPlaylistsForMenu, sharedPlaylists, showError, showSuccess],
  );

  const handleNavigateArtist = useCallback(
    (track) => {
      if (!track?.artistMbid) return;
      navigate(`/artist/${encodeURIComponent(track.artistMbid)}`, {
        state: { artistName: track.artistName },
      });
    },
    [navigate],
  );

  const handleAdoptFlow = useCallback(
    async (playlist) => {
      if (playlist.adoptedFlowId) {
        navigate(
          `/playlists?selected=${encodeURIComponent(playlist.adoptedFlowId)}`,
        );
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
        navigate(
          `/playlists?selected=${encodeURIComponent(playlist.adoptedPlaylistId)}`,
        );
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

  const recipeMeta = expandedPlaylist ? formatRecipeMeta(expandedPlaylist) : null;
  const focusTags = expandedPlaylist
    ? Array.isArray(expandedPlaylist.tags)
      ? expandedPlaylist.tags
      : []
    : [];
  const focusArtists = expandedPlaylist
    ? Array.isArray(expandedPlaylist.relatedArtists)
      ? expandedPlaylist.relatedArtists
      : []
    : [];

  const expandedToolbar = expandedPlaylist ? (
    <div className="discover-playlist-toolbar">
      <div className="discover-playlist-toolbar__meta">
        <div className="discover-playlist-toolbar__title-row">
          <h3 className="discover-playlist-toolbar__title artist-truncate">
            {expandedPlaylist.name}
          </h3>
          {expandedPlaylist.trackCount ? (
            <span className="discover-playlist-toolbar__track-count">
              {expandedPlaylist.trackCount} tracks
            </span>
          ) : null}
        </div>
        {expandedPlaylist.description ? (
          <p className="artist-card-meta artist-clamp-2">
            {expandedPlaylist.description}
          </p>
        ) : null}
        {recipeMeta ? (
          <p className="artist-card-meta">{recipeMeta}</p>
        ) : null}
        {(focusTags.length > 0 || focusArtists.length > 0) && (
          <div className="discover-playlist-flow-meta__pills">
            {focusTags.map((tag) => (
              <span
                key={`tag-${tag}`}
                className="discover-playlist-flow-meta__pill"
              >
                #{tag}
              </span>
            ))}
            {focusArtists.map((artist) => (
              <span
                key={`artist-${artist}`}
                className="discover-playlist-flow-meta__pill"
              >
                ~{artist}
              </span>
            ))}
          </div>
        )}
      </div>
      <DiscoverPlaylistContextMenu
        playlist={expandedPlaylist}
        canAdopt={canAdopt}
        adoptingFlowId={adoptingFlowId}
        adoptingPlaylistId={adoptingPlaylistId}
        onAdoptFlow={handleAdoptFlow}
        onAdoptPlaylist={handleAdoptPlaylist}
        triggerVariant="add"
        className="discover-playlist-toolbar__actions"
      />
    </div>
  ) : null;

  return (
    <DiscoverRail
      title="Playlists for you"
      afterTitle={
        playlistsUpdating ? (
          <span className="artist-discover-hero__updated artist-discover-hero__updated--refreshing">
            <Loader className="artist-discover-hero__updated-icon animate-spin" />
            {playlistsUpdateMessage || "Updating playlists..."}
          </span>
        ) : null
      }
      footer={
        expandedPlaylist ? (
          <div ref={expandedPanelRef} className="discover-playlist-expanded">
            <FlowTracksPanel
              tracks={expandedTracks}
              loading={false}
              showPlaybackControls={false}
              hideAlbumColumn
              hideStatusColumn
              emptyMessage="No tracks in this playlist."
              headerActions={expandedToolbar}
              playlists={sharedPlaylists}
              playlistsLoading={playlistsLoading}
              playlistSavingKey={playlistMenuSavingKey}
              playlistMenuError={playlistMenuError}
              getDefaultPlaylistName={getDefaultPlaylistName}
              onLoadPlaylists={loadPlaylistsForMenu}
              onAddTrackToPlaylist={handleAddTrackToPlaylist}
              onNavigateArtist={handleNavigateArtist}
            />
          </div>
        ) : null
      }
    >
      <div ref={playlistCardsRef} className="discover-playlist-cards">
      {visiblePlaylists.map((playlist) => {
        const CoverIcon = getPlaylistCoverIcon(playlist);
        const sourceLine = getPlaylistSourceLine(playlist);
        const isExpanded = expandedId === playlist.presetId;
        const showArtwork =
          Number(playlist.trackCount) > 0 &&
          !failedArtworkIds[playlist.presetId];

        return (
          <div key={playlist.presetId} className="artist-discover-shelf-card">
            <div
              className={`artist-discover-card artist-discover-card--playlist${isExpanded ? " is-expanded" : ""}`}
            >
              <button
                type="button"
                className="artist-discover-card__cover"
                onClick={() => handleToggle(playlist.presetId)}
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${playlist.name}`}
              >
                {showArtwork ? (
                  <img
                    src={getDiscoverArtworkUrl(
                      playlist.presetId,
                      artworkVersion,
                    )}
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
                    <CoverIcon className="artist-icon-lg" />
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
                      onClick={() => handleToggle(playlist.presetId)}
                      aria-expanded={isExpanded}
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
                    <p
                      className="artist-card-meta--discover"
                      title={sourceLine}
                    >
                      {sourceLine}
                    </p>
                  ) : null}
                </div>
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
        );
      })}
      </div>
    </DiscoverRail>
  );
}

DiscoverPlaylistSection.propTypes = {
  playlists: PropTypes.arrayOf(PropTypes.object),
  artworkVersion: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  canAdopt: PropTypes.bool,
  playlistsUpdating: PropTypes.bool,
  playlistsUpdateMessage: PropTypes.string,
  onFlowAdopted: PropTypes.func,
  onPlaylistAdopted: PropTypes.func,
};
