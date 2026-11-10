import { useMemo, useState } from "react";
import type { AriaRole, ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ListMusic, Plus } from "../components/icons";
import { parseResponse } from "hono/client";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { asApiError, resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { browsePlaylistQueryOptions } from "../queryOptions.ts";
import { isBrowseProvider, type BrowseProvider } from "../../../lib/browsePlaylists.ts";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../components/CollectionHeader";
import TooltipButton from "../components/TooltipButton";
import Tooltip from "../components/Tooltip";
import RouteLink from "../components/RouteLink";
import {
  SkeletonCollectionHeader,
  SkeletonCollectionTracks,
  SkeletonStatus,
} from "../components/Skeletons";
import { DotLoader } from "../components/DotLoader";
import {
  PlaylistTracksPanel,
  usePlaylistTrackPlayback,
} from "./playlists/components/playlistTrackComponents.tsx";
import { formatTrackTotal } from "./playlists/playlistPageUtils";
import { getApiErrorMessage } from "../utils/api/errors.ts";
import { playlistPath } from "../navigation/playlistPaths";
import { readRouteSeed } from "../navigation/routeSeed.ts";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import { useTrackSaveActions } from "../hooks/useTrackSaveActions";
import { mapPreviewTracks, type PreviewTrack } from "./deezerPreviewTracks.ts";

const SAVE_COPY: Record<
  BrowseProvider,
  { add: string; open: string; added: (name: string) => string; unavailable: string }
> = {
  deezer: {
    add: "Add synced playlist",
    open: "Open synced playlist",
    added: (name) => `Added ${name} to your playlists. It syncs with Deezer daily.`,
    unavailable: "Deezer no longer has this playlist.",
  },
  discovery: {
    add: "Add to Library",
    open: "Open playlist",
    added: (name) => `Added ${name} to your playlists. Missing songs will download.`,
    unavailable: "This playlist was replaced by a newer one.",
  },
  mix: {
    add: "Save as playlist",
    open: "Open playlist",
    added: (name) => `Saved ${name} to your playlists.`,
    unavailable: "This mix was replaced by a newer one.",
  },
};

export default function BrowsePlaylistDetailPage() {
  const { provider, playlistId } = useParams();
  if (!isBrowseProvider(provider) || !playlistId) {
    return <Navigate to="/discover/playlists" replace />;
  }
  return (
    <BrowsePlaylistDetail
      key={`${provider}:${playlistId}`}
      provider={provider}
      playlistId={playlistId}
    />
  );
}

function BrowsePlaylistDetail({
  provider,
  playlistId,
}: {
  provider: BrowseProvider;
  playlistId: string;
}) {
  const copy = SAVE_COPY[provider];
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [adding, setAdding] = useState(false);
  const [savedPlaylistId, setSavedPlaylistId] = useState<string | null>(null);
  const [failedArtwork, setFailedArtwork] = useState(false);
  const playlistQueryOptions = browsePlaylistQueryOptions(user?.id, provider, playlistId);
  const { queryKey } = playlistQueryOptions;

  const { data: playlist, error, isPending, refetch } = useQuery(playlistQueryOptions);
  const seed = readRouteSeed(useLocation().state);
  const shown = playlist || (isPending && seed?.name ? seed : null);
  useDocumentTitle(shown?.name || "Playlist");

  const tracks = useMemo(
    () => mapPreviewTracks(playlist?.tracks, playlistId),
    [playlist?.tracks, playlistId],
  );
  const playbackSource = useMemo(
    () => ({
      type: `${provider}-playlist`,
      id: playlistId,
      label: playlist?.name || "Playlist",
      recordHistory: true,
    }),
    [playlist?.name, playlistId, provider],
  );
  const playback = usePlaylistTrackPlayback({ tracks, playbackSource });
  const trackSaveActions = useTrackSaveActions();

  const getArtistLink = (track: PreviewTrack) => {
    const to = resolveArtistPath({ name: track.artistName });
    return to ? { to } : null;
  };
  const getAlbumLink = (track: PreviewTrack) => {
    const to = resolveAlbumPath({
      artistName: track.artistName,
      albumName: track.albumName,
      deezerAlbumId: track.deezerAlbumId,
    });
    return to ? { to } : null;
  };
  const openLink = (link: { to: string } | null) => {
    if (link) navigate(link.to);
  };

  const handleAdd = async () => {
    setAdding(true);
    try {
      const result = await parseResponse(
        discoveryClient.playlists[":provider"][":playlistId"].library.$post({
          param: { provider, playlistId: encodeURIComponent(playlistId) },
        }),
      );
      setSavedPlaylistId(result.playlistId);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trendingPrefix });
      showSuccess(
        result.alreadyAdded
          ? `${result.name} is already in your playlists`
          : copy.added(result.name),
      );
    } catch (err) {
      showError(
        getApiErrorMessage(err, "Couldn't add this playlist. Nothing was added. Try again."),
      );
    } finally {
      setAdding(false);
    }
  };

  const renderState = (content: ReactNode, role: AriaRole) => (
    <div className="library-page native-library-page collection-page">
      <div className="native-library-content">
        <div className="native-library-state" role={role}>
          {content}
        </div>
      </div>
    </div>
  );

  if (isPending && !shown) {
    return (
      <CollectionPage>
        <SkeletonStatus label="Loading playlist" className="native-library-detail">
          <SkeletonCollectionHeader description icons={2} />
          <SkeletonCollectionTracks />
        </SkeletonStatus>
      </CollectionPage>
    );
  }

  if (!shown) {
    const notFound = asApiError(error)?.response?.status === 404;
    return renderState(
      <>
        <strong>{notFound ? "Playlist not found" : "Playlist unavailable"}</strong>
        <span>
          {notFound
            ? copy.unavailable
            : getApiErrorMessage(error, "This playlist didn't load. Try again.")}
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

  const ready = Boolean(playlist);
  const libraryPlaylistId = playlist?.libraryPlaylistId ?? savedPlaylistId;
  const canAdd = hasPermission("accessPlaylists");
  const addLabel = libraryPlaylistId ? copy.open : copy.add;
  const artworkUrl = resolveAuthenticatedApiAssetUrl(shown.artworkUrl) || null;
  const showArtwork = Boolean(artworkUrl) && !failedArtwork;
  const trackTotal = ready
    ? tracks.length
    : Number("trackCount" in shown ? shown.trackCount : undefined);

  return (
    <CollectionPage tintSrc={showArtwork ? artworkUrl : null}>
      <CollectionHeader
        cover={
          showArtwork ? (
            <img
              src={artworkUrl ?? undefined}
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
        title={shown.name}
        subtitle={("description" in shown ? shown.description : undefined) || null}
        meta={Number.isFinite(trackTotal) ? formatTrackTotal(trackTotal) : null}
        actions={
          <>
            <CollectionPlayButtons
              label={shown.name || "Playlist"}
              disabled={!ready || playback.disabled}
              isPlaying={playback.isListPlaying}
              isShuffleEnabled={playback.isShuffleEnabled}
              onPlay={playback.handlePlayAll}
              onShuffle={playback.handleShufflePlay}
            />
            {canAdd && libraryPlaylistId ? (
              <Tooltip content={addLabel}>
                <RouteLink
                  to={playlistPath(libraryPlaylistId)}
                  state={{ created: true }}
                  className="native-library-favorite is-active"
                  aria-label={addLabel}
                >
                  <Check aria-hidden="true" />
                </RouteLink>
              </Tooltip>
            ) : canAdd ? (
              <TooltipButton
                className="native-library-favorite"
                onClick={handleAdd}
                disabled={!ready || adding}
                label={addLabel}
                aria-label={addLabel}
              >
                {adding ? <DotLoader size="sm" label={null} /> : <Plus aria-hidden="true" />}
              </TooltipButton>
            ) : null}
          </>
        }
      />
      {ready ? (
        <PlaylistTracksPanel
          label={`${playlist!.name} tracks`}
          tracks={tracks}
          loading={false}
          playbackSource={playbackSource}
          emptyMessage="This playlist has no tracks."
          onNavigateArtist={(track: PreviewTrack) => openLink(getArtistLink(track))}
          onNavigateAlbum={(track: PreviewTrack) => openLink(getAlbumLink(track))}
          getArtistLink={getArtistLink}
          getAlbumLink={getAlbumLink}
          {...trackSaveActions}
        />
      ) : (
        <SkeletonStatus label="Loading tracks">
          <SkeletonCollectionTracks count={Math.min(trackTotal || 10, 12)} />
        </SkeletonStatus>
      )}
    </CollectionPage>
  );
}
