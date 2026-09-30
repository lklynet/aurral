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
import { AudioWaveform, Crosshair, ListMusic, MoreVertical, Plus } from "lucide-react";

import { Link, useParams } from "react-router-dom";
import { FlowTracksPanel, useFlowTrackPlayback } from "./flows/flowComponents/flowTrackComponents.jsx";
import { CollectionHeader, CollectionPage, CollectionPlayButtons } from "../components/CollectionHeader";
import { LibraryItemMenu } from "../components/LibraryItemMenu";
import { getReleaseGroupCoversBatch } from "../utils/api/endpoints/artists.js";
import { formatTrackTotal } from "./flows/playlistShared";
import { DotLoader } from "../components/DotLoader";
import { flowPath, playlistPath } from "../navigation/playlistPaths";
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
        navigate(flowPath(playlist.adoptedFlowId));
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
          navigate(flowPath(flowId));
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
        navigate(playlistPath(playlist.adoptedPlaylistId));
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
          navigate(playlistPath(playlistId));
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

  const renderState = (content, role) => (
    <main className="library-page native-library-page collection-page">
      <div className="native-library-content">
        <div className="native-library-state" role={role}>
          {content}
        </div>
      </div>
    </main>
  );

  const playbackSource = useMemo(
    () => ({
      type: "discover-playlist-preview",
      id: presetId,
      label: playlist?.name || "Playlist",
      recordHistory: false,
    }),
    [playlist?.name, presetId],
  );
  const playback = useFlowTrackPlayback({ tracks, playbackSource });

  const handleNavigateAlbum = useCallback(
    (track) => {
      if (!track?.artistMbid || !track?.albumMbid) return;
      navigate(`/artist/${track.artistMbid}/release/${track.albumMbid}`, {
        state: {
          artistName: track.artistName,
          focusReleaseGroupMbid: track.albumMbid,
          focusReleaseGroup: { id: track.albumMbid, title: track.albumName || "" },
        },
      });
    },
    [navigate],
  );

  const [artworkByAlbumMbid, setArtworkByAlbumMbid] = useState({});
  useEffect(() => {
    const items = tracks
      .filter((track) => track.albumMbid)
      .map((track) => ({
        mbid: track.albumMbid,
        artistName: track.artistName,
        albumTitle: track.albumName,
      }));
    if (!items.length) return undefined;
    let cancelled = false;
    getReleaseGroupCoversBatch(items)
      .then((covers) => {
        if (cancelled) return;
        setArtworkByAlbumMbid(
          Object.fromEntries(
            Object.entries(covers || {})
              .map(([mbid, cover]) => [mbid, cover?.image || ""])
              .filter(([, image]) => image),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tracks]);

  if (!data && !error) {
    return renderState(
      <>
        <DotLoader size="xl" label={null} />
        <span>Loading playlist…</span>
      </>,
      "status",
    );
  }

  if (!playlist) {
    return renderState(
      <>
        <strong>{error ? "Playlist unavailable" : "Playlist not found"}</strong>
        <span>{error || "This discovery playlist is no longer available."}</span>
        <Link className="native-library-state__action" to="/discover/playlists">
          Back to playlists
        </Link>
      </>,
      error ? "alert" : undefined,
    );
  }

  const isBusy = adoptingFlowId === playlist.presetId || adoptingPlaylistId === playlist.presetId;
  const isPreviewPlaylist = playlist.type === "editorial";

  return (
    <CollectionPage tintSrc={artworkUrl} tintColor={heroColor}>
      <CollectionHeader
        cover={
          showArtwork ? (
            <img src={artworkUrl} alt="" loading="eager" onError={() => setFailedArtwork(true)} />
          ) : (
            <div
              className="discover-playlist-detail__cover-fallback"
              style={{ backgroundColor: heroColor }}
            >
              {isPreviewPlaylist ? <Crosshair className="artist-icon-xl" aria-hidden="true" /> : null}
              {sourceLine ? (
                <span
                  className="discover-playlist-detail__cover-label"
                  style={{ color: getPlaylistTextColor(heroColor) }}
                >
                  {sourceLine}
                </span>
              ) : null}
            </div>
          )
        }
        context={<Link to="/discover/playlists">Discover playlists</Link>}
        kicker={sourceLine ? `${sourceLine} playlist` : "Playlist"}
        title={playlist.name}
        subtitle={playlist.description || null}
        meta={formatTrackTotal(Number(playlist.trackCount || tracks.length))}
        status={
          previewMessage ? (
            <p className="native-library-detail__meta" role="status">
              {previewMessage}
            </p>
          ) : null
        }
        actions={
          <>
            {isPreviewPlaylist ? (
              <CollectionPlayButtons
                label={`${playlist.name} previews`}
                disabled={playback.disabled}
                isPlaying={playback.isListPlaying}
                isShuffleEnabled={playback.isShuffleEnabled}
                onPlay={playback.handlePlayAll}
                onShuffle={playback.handleShufflePlay}
              />
            ) : null}
            <LibraryItemMenu
              label={playlist.name}
              contextMenu={false}
              disabled={isBusy}
              triggerLabel="Add to library"
              triggerClassName="native-library-item-menu__trigger collection-header__add"
              triggerIcon={
                <>
                  {isBusy ? <DotLoader size="sm" label={null} /> : <Plus aria-hidden="true" />}
                  <MoreVertical aria-hidden="true" />
                </>
              }
              menuLabel="Add to library"
              items={[
                {
                  id: "flow",
                  label: playlist.adoptedFlowId ? "Open rotating flow" : "Add as rotating flow",
                  icon: AudioWaveform,
                  onSelect: handleAdoptFlow,
                },
                {
                  id: "playlist",
                  label: playlist.adoptedPlaylistId ? "Open static playlist" : "Add as static playlist",
                  icon: ListMusic,
                  onSelect: handleAdoptPlaylist,
                },
              ]}
            />
          </>
        }
      />
      <FlowTracksPanel
        label={`${playlist.name} tracks`}
        tracks={tracks}
        loading={false}
        playbackSource={playbackSource}
        showPlaybackControls={isPreviewPlaylist}
        emptyMessage="No tracks in this playlist."
        playlists={sharedPlaylists}
        playlistsLoading={playlistsLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistMenuError={playlistMenuError}
        getDefaultPlaylistName={getDefaultPlaylistName}
        onLoadPlaylists={loadSharedPlaylists}
        onAddTrackToPlaylist={handleAddTrackToPlaylist}
        onNavigateArtist={handleNavigateArtist}
        onNavigateAlbum={handleNavigateAlbum}
        artworkByAlbumMbid={artworkByAlbumMbid}
      />
    </CollectionPage>
  );
}
