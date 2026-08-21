import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Music, Star } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import AddActionButton from "../../../components/AddActionButton";
import { getReleaseGroupTracks } from "../../../utils/api/endpoints/artists.js";
import { buildAurralPick, getReleaseGroupCoverUrl, getReleaseMetric } from "../utils";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";
import { TrackPlayButton } from "./TrackPlayButton";
import { ArtistTrackListToolbar } from "./ArtistTrackListToolbar";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizePreviewTrack } from "../../../utils/audioQueue";
import { queryKeys } from "../../../queryClient.js";

function PickCover({ pick, albumCovers, fulfilledCoverIds, artistCoverImage }) {
  const cover = getReleaseGroupCoverUrl(pick?.releaseGroup, albumCovers, {
    artistFallback: artistCoverImage,
    resolved: fulfilledCoverIds?.has(pick?.releaseGroupId),
  });
  if (cover) {
    return <img src={cover} alt="" loading="lazy" decoding="async" />;
  }
  return (
    <div className="artist-media-placeholder">
      <Music className="artist-icon-lg" />
    </div>
  );
}

const formatDuration = (track) => {
  const duration = Number(track?.length || track?.duration_ms || 0);
  if (!Number.isFinite(duration) || duration <= 0) return "";
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const TRACK_PREVIEW_LIMIT = 6;

export function ArtistDetailsDownloadTargets({
  releaseGroups = [],
  getAlbumStatus,
  artist,
  albumCovers,
  fulfilledCoverIds,
  artistCoverImage,
  canAddAlbum,
  requestingAlbum,
  handleRequestAlbum,
  artistName = "",
  playbackSource = null,
  onAddTrackToPlaylist,
  onAddTrackToLibrary,
  libraryTrackSavingKeys,
  resolveMembershipTrack,
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistError,
  getDefaultPlaylistName,
  onLoadPlaylists,
}) {
  const missingReleasePick = useMemo(
    () => buildAurralPick({ releaseGroups, getAlbumStatus }),
    [releaseGroups, getAlbumStatus],
  );
  const [showAllTracks, setShowAllTracks] = useState(false);
  const releaseGroup = missingReleasePick?.releaseGroup;
  const trackContext = useMemo(
    () => ({
      artistMbid: artist?.id || "",
      artistName: artist?.name || "",
      albumTitle: missingReleasePick?.title || releaseGroup?.title || "",
      releaseType: missingReleasePick?.type || releaseGroup?.["primary-type"] || "",
      releaseDate: releaseGroup?.["first-release-date"] || "",
      deezerAlbumId: releaseGroup?._deezerAlbumId || "",
    }),
    [
      artist?.id,
      artist?.name,
      missingReleasePick?.title,
      missingReleasePick?.type,
      releaseGroup,
    ],
  );
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(missingReleasePick?.releaseGroupId, trackContext),
    queryFn: ({ signal }) =>
      getReleaseGroupTracks(missingReleasePick.releaseGroupId, { ...trackContext, signal }),
    enabled: Boolean(missingReleasePick?.releaseGroupId),
    staleTime: 5 * 60 * 1000,
  });
  const tracks = useMemo(
    () => (Array.isArray(tracksQuery.data) ? tracksQuery.data : []),
    [tracksQuery.data],
  );
  const loadingTracks = tracksQuery.isPending;

  useEffect(() => {
    setShowAllTracks(false);
  }, [missingReleasePick?.releaseGroupId]);

  const visibleTracks =
    showAllTracks || tracks.length <= TRACK_PREVIEW_LIMIT
      ? tracks
      : tracks.slice(0, TRACK_PREVIEW_LIMIT);
  const hasHiddenTracks = tracks.length > TRACK_PREVIEW_LIMIT;

  const normalizeTrack = useCallback(
    (track, index) =>
      normalizePreviewTrack(
        {
          id: track?.id ?? track?.mbid ?? `pick-${index}`,
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        artistName || artist?.name || "",
        {
          album: missingReleasePick?.title || "",
          artistMbid: artist?.id || "",
          albumMbid: missingReleasePick?.releaseGroupId || "",
        },
      ),
    [artist?.id, artist?.name, artistName, missingReleasePick?.releaseGroupId, missingReleasePick?.title],
  );

  const { currentTrack, isPlaying, isLoading, playTrack, togglePlayPause, source } =
    useAudioQueue();

  const handlePlay = useCallback(
    (track, options = {}, ...normalizeArgs) => {
      const normalized = normalizeTrack(track, ...normalizeArgs);
      if (!normalized?.src) return;
      if (currentTrack?.id === normalized.id) {
        togglePlayPause();
        return;
      }
      playTrack(normalized, {
        source: options.source ?? source,
        queue: options.queue,
        shuffle: options.shuffle,
        updateShufflePreference: options.updateShufflePreference,
      });
    },
    [currentTrack?.id, normalizeTrack, playTrack, source, togglePlayPause],
  );

  const isTrackPlaying = useCallback(
    (trackId) => !!trackId && currentTrack?.id === String(trackId) && (isPlaying || isLoading),
    [currentTrack?.id, isLoading, isPlaying],
  );

  const isTrackLoading = useCallback(
    (trackId) => !!trackId && currentTrack?.id === String(trackId) && isLoading,
    [currentTrack?.id, isLoading],
  );

  const getQueueTracks = useCallback(
    () =>
      tracks
        .filter((entry) => entry?.preview_url)
        .map((entry, entryIndex) => normalizeTrack(entry, entryIndex)),
    [tracks, normalizeTrack],
  );

  const {
    disabled: toolbarDisabled,
    isListPlaying,
    isShuffleEnabled,
    handlePlayAll,
    handleShufflePlay,
  } = useAlbumTrackListToolbar({
    getQueueTracks,
    playbackSource,
  });

  const handleTrackPreviewPlay = (track, index, event) => {
    event.stopPropagation();
    if (!track?.preview_url) return;
    const queue = tracks
      .filter((entry) => entry?.preview_url)
      .map((entry, entryIndex) => normalizeTrack(entry, entryIndex));
    handlePlay(track, { source: playbackSource, queue }, index);
  };

  if (!missingReleasePick) return null;

  const metric = missingReleasePick.metric || getReleaseMetric(missingReleasePick.releaseGroup);

  return (
    <section className="artist-section">
      <div className="artist-pick-panel">
        <div className="artist-pick-panel__grid">
          <div className="artist-pick-panel__feature">
            <div className="artist-media-cell">
              <PickCover
                pick={missingReleasePick}
                albumCovers={albumCovers}
                fulfilledCoverIds={fulfilledCoverIds}
                artistCoverImage={artistCoverImage}
              />
            </div>
            <div className="artist-pick-panel__content">
              <div className="artist-min-0">
                <h2 className="artist-pick-title">{missingReleasePick.title}</h2>
                <div className="artist-meta-line">
                  {missingReleasePick.year && <span>{missingReleasePick.year}</span>}
                  {missingReleasePick.type && <span>{missingReleasePick.type}</span>}
                  {metric?.label && (
                    <span className="artist-meta-line__item">
                      <Star className="artist-star-icon" />
                      {metric.label}
                    </span>
                  )}
                </div>
              </div>
              {canAddAlbum && missingReleasePick.releaseGroupId && (
                <div>
                  <AddActionButton
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRequestAlbum(missingReleasePick.releaseGroupId, missingReleasePick.title);
                    }}
                    isLoading={requestingAlbum === missingReleasePick.releaseGroupId}
                    disabled={requestingAlbum === missingReleasePick.releaseGroupId}
                    label="Add to Lidarr"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="artist-pick-panel__tracks artist-min-0">
            {loadingTracks ? (
              <div className="artist-loading">
                <DotLoader size="xl" label={null} />
              </div>
            ) : tracks.length ? (
              <>
                <div className="artist-pick-panel__tracks-header">
                  <ArtistTrackListToolbar
                    disabled={toolbarDisabled}
                    isPlaying={isListPlaying}
                    isShuffleEnabled={isShuffleEnabled}
                    onPlayAll={handlePlayAll}
                    onShufflePlay={handleShufflePlay}
                  />
                </div>
                <div className="artist-pick-panel__track-grid">
                  {visibleTracks.map((track, index) => {
                    const currentTrackId = String(track.id ?? track.mbid ?? `pick-${index}`);
                    const isPlaying = isTrackPlaying(currentTrackId);
                    const isLoadingPreview = isTrackLoading(currentTrackId);
                    return (
                      <div
                        key={currentTrackId}
                        className="artist-track-row artist-track-row--compact"
                      >
                        <span className="artist-track-number">
                          {track.trackNumber || track.position || index + 1}
                        </span>
                        {track.preview_url ? (
                          <TrackPlayButton
                            track={track}
                            isPlaying={isPlaying}
                            isLoading={isLoadingPreview}
                            onClick={(event) => handleTrackPreviewPlay(track, index, event)}
                          />
                        ) : (
                          <span />
                        )}
                        <span className="artist-track-title">
                          {track.title || track.trackName || "Unknown Track"}
                        </span>
                        {onAddTrackToPlaylist ? (
                          <TrackPlaylistMenu
                            track={
                              resolveMembershipTrack
                                ? resolveMembershipTrack(track, missingReleasePick.releaseGroup)
                                : track
                            }
                            triggerVariant="kebab"
                            playlists={playlists}
                            loading={playlistsLoading}
                            saving={playlistSavingKey === currentTrackId}
                            librarySaving={libraryTrackSavingKeys?.has(currentTrackId)}
                            error={playlistError}
                            defaultNewPlaylistName={getDefaultPlaylistName?.(
                              track,
                              missingReleasePick.releaseGroup,
                            )}
                            onLoadPlaylists={onLoadPlaylists}
                            onAddToLibrary={
                              onAddTrackToLibrary
                                ? () =>
                                    onAddTrackToLibrary(
                                      track,
                                      missingReleasePick.releaseGroup,
                                      currentTrackId,
                                    )
                                : null
                            }
                            onSelect={(target) =>
                              onAddTrackToPlaylist(track, missingReleasePick.releaseGroup, target)
                            }
                          />
                        ) : null}
                        <span className="artist-track-duration">{formatDuration(track)}</span>
                      </div>
                    );
                  })}
                </div>
                {hasHiddenTracks ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm artist-pick-panel__show-all"
                    onClick={() => setShowAllTracks((current) => !current)}
                  >
                    {showAllTracks ? "Show fewer tracks" : `Show all ${tracks.length} tracks`}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
