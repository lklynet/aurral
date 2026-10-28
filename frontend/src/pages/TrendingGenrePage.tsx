import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import ArtworkImage from "../components/ArtworkImage";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../components/CollectionHeader";
import {
  SkeletonCollectionHeader,
  SkeletonCollectionTracks,
  SkeletonStatus,
} from "../components/Skeletons";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import { trendingGenreQueryOptions } from "../queryOptions.ts";
import { asApiError } from "../utils/api/core.ts";
import { mapPreviewTracks, type PreviewTrack } from "./deezerPreviewTracks.ts";
import { getApiErrorMessage } from "./onboardingUtils";
import {
  PlaylistTracksPanel,
  usePlaylistTrackPlayback,
} from "./playlists/components/playlistTrackComponents.tsx";
import { formatTrackTotal } from "./playlists/playlistPageUtils";
import { useTrackSaveActions } from "./useTrackSaveActions";
import "./TrendingPage.css";

export default function TrendingGenrePage() {
  const genreId = useParams().genreId!;
  const navigate = useNavigate();
  const { data: chart, error, isPending, refetch } = useQuery(trendingGenreQueryOptions(genreId));
  const title = chart ? `Top ${chart.name}` : "Genre chart";
  useDocumentTitle(title);

  const tracks = useMemo(
    () => mapPreviewTracks(chart?.items, `trending-genre-${genreId}`),
    [chart?.items, genreId],
  );
  const playbackSource = useMemo(
    () => ({ type: "trending-genre", id: genreId, label: title, recordHistory: false }),
    [genreId, title],
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

  if (isPending) {
    return (
      <CollectionPage>
        <SkeletonStatus label="Loading chart" className="native-library-detail">
          <SkeletonCollectionHeader kicker={false} icons={1} />
          <SkeletonCollectionTracks />
        </SkeletonStatus>
      </CollectionPage>
    );
  }

  if (!chart) {
    const notFound = asApiError(error)?.response?.status === 404;
    return (
      <div className="library-page native-library-page collection-page">
        <div className="native-library-content">
          <div className="native-library-state" role="alert">
            <strong>{notFound ? "Chart not found" : "Chart unavailable"}</strong>
            <span>
              {notFound
                ? "Aurral doesn't have this genre chart yet."
                : getApiErrorMessage(error, "Aurral couldn't load this chart. Try again.")}
            </span>
            {notFound ? (
              <Link className="native-library-state__action" to="/discover/trending">
                Back to Trending
              </Link>
            ) : (
              <button
                type="button"
                className="native-library-state__action"
                onClick={() => refetch()}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const covers = chart.items
    .map((item) => item.artworkUrl)
    .filter((url) => url !== null)
    .slice(0, 4);

  return (
    <CollectionPage tintSrc={covers[0] ?? null}>
      <CollectionHeader
        cover={
          <div className="trending-genre-card__cover">
            {covers.map((cover) => (
              <ArtworkImage key={cover} src={cover} alt="" loading="eager" />
            ))}
          </div>
        }
        title={title}
        meta={formatTrackTotal(tracks.length)}
        actions={
          <CollectionPlayButtons
            label={`${title} previews`}
            disabled={playback.disabled}
            isPlaying={playback.isListPlaying}
            isShuffleEnabled={playback.isShuffleEnabled}
            onPlay={playback.handlePlayAll}
            onShuffle={playback.handleShufflePlay}
          />
        }
      />
      <PlaylistTracksPanel
        label={`${title} tracks`}
        tracks={tracks}
        loading={false}
        playbackSource={playbackSource}
        emptyMessage="This chart has no tracks."
        onNavigateArtist={(track: PreviewTrack) => openLink(getArtistLink(track))}
        onNavigateAlbum={(track: PreviewTrack) => openLink(getAlbumLink(track))}
        getArtistLink={getArtistLink}
        getAlbumLink={getAlbumLink}
        {...trackSaveActions}
      />
    </CollectionPage>
  );
}
