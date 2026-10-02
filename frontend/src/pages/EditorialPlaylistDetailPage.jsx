import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ListMusic, Plus } from "lucide-react";
import {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  resolveEditorialTrackLinks,
} from "../utils/api/endpoints/discovery.js";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { queryClient, queryKeys } from "../queryClient.js";
import { CollectionHeader, CollectionPage, CollectionPlayButtons } from "../components/CollectionHeader";
import TooltipButton from "../components/TooltipButton";
import { DotLoader } from "../components/DotLoader";
import { FlowTracksPanel, useFlowTrackPlayback } from "./flows/flowComponents/flowTrackComponents.jsx";
import { formatTrackTotal } from "./flows/playlistShared";
import { getApiErrorMessage } from "./onboardingUtils";
import { playlistPath } from "../navigation/playlistPaths";
import { useTrackSaveActions } from "./useTrackSaveActions";

const mapPreviewTracks = (tracks, playlistId) =>
  (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
    id: `deezer-${playlistId}-${index}`,
    artistName: track?.artistName || "Unknown Artist",
    trackName: track?.trackName || "Unknown Track",
    albumName: track?.albumName || null,
    durationMs: track?.durationMs || null,
    reason: "Deezer playlist",
    status: track?.preview_url ? "done" : "pending",
    streamUrl: track?.preview_url || null,
    artworkUrl: track?.artworkUrl || null,
    deezerAlbumId: track?.deezerAlbumId || null,
    resolvesLinks: true,
  }));

export default function EditorialPlaylistDetailPage() {
  const { playlistId } = useParams();
  const { user, hasPermission } = useAuth();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();
  const [adding, setAdding] = useState(false);
  const [failedArtwork, setFailedArtwork] = useState(false);
  const queryKey = queryKeys.editorialPlaylist(user?.id, playlistId);

  const { data: playlist, error, isPending, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => getEditorialPlaylist(playlistId, { signal }),
    staleTime: 5 * 60 * 1000,
  });
  useDocumentTitle(playlist?.name || "Playlist");

  const tracks = useMemo(
    () => mapPreviewTracks(playlist?.tracks, playlistId),
    [playlist?.tracks, playlistId],
  );
  const playbackSource = useMemo(
    () => ({
      type: "editorial-playlist-preview",
      id: playlistId,
      label: playlist?.name || "Playlist",
      recordHistory: false,
    }),
    [playlist?.name, playlistId],
  );
  const playback = useFlowTrackPlayback({ tracks, playbackSource });
  const trackSaveActions = useTrackSaveActions();

  const openTrackLink = async (track, kind) => {
    try {
      const { artistMbid, albumMbid } = await resolveEditorialTrackLinks({
        artistName: track.artistName,
        albumName: kind === "album" ? track.albumName : null,
        deezerAlbumId: kind === "album" ? track.deezerAlbumId : null,
      });
      if (!artistMbid) {
        showError(`Couldn't find ${track.artistName} in MusicBrainz`);
        return;
      }
      if (kind === "album" && albumMbid) {
        navigate(`/artist/${artistMbid}/release/${albumMbid}`, {
          state: {
            artistName: track.artistName,
            focusReleaseGroupMbid: albumMbid,
            focusReleaseGroup: { id: albumMbid, title: track.albumName || "" },
          },
        });
        return;
      }
      if (kind === "album") showError(`Couldn't find ${track.albumName}. Opening ${track.artistName} instead.`);
      navigate(`/artist/${artistMbid}`, { state: { artistName: track.artistName } });
    } catch (err) {
      showError(getApiErrorMessage(err, "Couldn't open this link. Try again."));
    }
  };

  const handleAdd = async () => {
    if (playlist?.libraryPlaylistId) {
      navigate(playlistPath(playlist.libraryPlaylistId));
      return;
    }
    setAdding(true);
    try {
      const result = await addEditorialPlaylistToLibrary(playlistId);
      queryClient.setQueryData(queryKey, (current) =>
        current ? { ...current, libraryPlaylistId: result.playlistId } : current,
      );
      showSuccess(
        result.alreadyAdded
          ? `${result.name} is already in your playlists`
          : `Added ${result.name} to your playlists. It syncs with Deezer daily.`,
      );
    } catch (err) {
      showError(getApiErrorMessage(err, "Couldn't add this playlist. Nothing was added. Try again."));
    } finally {
      setAdding(false);
    }
  };

  const renderState = (content, role) => (
    <main className="library-page native-library-page collection-page">
      <div className="native-library-content">
        <div className="native-library-state" role={role}>
          {content}
        </div>
      </div>
    </main>
  );

  if (isPending) {
    return renderState(
      <>
        <DotLoader size="xl" label={null} />
        <span>Loading playlist…</span>
      </>,
      "status",
    );
  }

  if (error || !playlist) {
    const notFound = error?.response?.status === 404;
    return renderState(
      <>
        <strong>{notFound ? "Playlist not found" : "Playlist unavailable"}</strong>
        <span>
          {notFound
            ? "Deezer no longer has this playlist."
            : getApiErrorMessage(error, "Deezer didn't respond. Try again.")}
        </span>
        {notFound ? (
          <Link className="native-library-state__action" to="/discover/playlists">
            Back to playlists
          </Link>
        ) : (
          <button type="button" className="native-library-state__action" onClick={() => refetch()}>
            Try again
          </button>
        )}
      </>,
      "alert",
    );
  }

  const inLibrary = Boolean(playlist.libraryPlaylistId);
  const canAdd = hasPermission("accessFlow");
  const addLabel = inLibrary ? "Open synced playlist" : "Add synced playlist";
  const showArtwork = Boolean(playlist.artworkUrl) && !failedArtwork;

  return (
    <CollectionPage tintSrc={showArtwork ? playlist.artworkUrl : null}>
      <CollectionHeader
        cover={
          showArtwork ? (
            <img
              src={playlist.artworkUrl}
              alt=""
              loading="eager"
              onError={() => setFailedArtwork(true)}
            />
          ) : (
            <div className="discover-playlist-detail__cover-fallback">
              <ListMusic className="artist-icon-xl" aria-hidden="true" />
            </div>
          )
        }
        kicker={playlist.curator ? `Deezer · ${playlist.curator}` : "Deezer playlist"}
        title={playlist.name}
        subtitle={playlist.description || null}
        meta={formatTrackTotal(tracks.length)}
        actions={
          <>
            <CollectionPlayButtons
              label={`${playlist.name} previews`}
              disabled={playback.disabled}
              isPlaying={playback.isListPlaying}
              isShuffleEnabled={playback.isShuffleEnabled}
              onPlay={playback.handlePlayAll}
              onShuffle={playback.handleShufflePlay}
            />
            {canAdd ? (
              <TooltipButton
                className={`native-library-favorite${inLibrary ? " is-active" : ""}`}
                onClick={handleAdd}
                disabled={adding}
                label={addLabel}
                aria-label={addLabel}
              >
                {adding ? (
                  <DotLoader size="sm" label={null} />
                ) : inLibrary ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
              </TooltipButton>
            ) : null}
          </>
        }
      />
      <FlowTracksPanel
        label={`${playlist.name} tracks`}
        tracks={tracks}
        loading={false}
        playbackSource={playbackSource}
        emptyMessage="This playlist has no tracks."
        onNavigateArtist={(track) => openTrackLink(track, "artist")}
        onNavigateAlbum={(track) => openTrackLink(track, "album")}
        {...trackSaveActions}
      />
    </CollectionPage>
  );
}
