import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Loader, Music, Star } from "lucide-react";
import AddAlbumButton from "../../../components/AddAlbumButton";
import { useImageGradientColors } from "../../../hooks/useImageGradientColors";
import { getReleaseGroupTracks } from "../../../utils/api";
import { buildAurralPick, getReleaseMetric } from "../utils";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";
import { TrackPlayButton } from "./TrackPlayButton";
import { ArtistTrackListToolbar } from "./ArtistTrackListToolbar";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useGlobalTrackPlayback } from "../../../hooks/useGlobalTrackPlayback";
import { normalizePreviewTrack } from "../../../utils/audioQueue";

function PickCover({ pick, albumCovers, artistCoverImage }) {
  const cover = albumCovers?.[pick.releaseGroupId] || artistCoverImage;
  if (cover) {
    return (
      <img
        src={cover}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <div className="artist-media-placeholder">
      <Music className="artist-icon-lg" />
    </div>
  );
}

PickCover.propTypes = {
  pick: PropTypes.object.isRequired,
  albumCovers: PropTypes.object,
  artistCoverImage: PropTypes.string,
};

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
  artistCoverImage,
  canAddAlbum,
  requestingAlbum,
  handleRequestAlbum,
  artistName = "",
  playbackSource = null,
  onAddTrackToPlaylist,
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
  const coverSrc =
    (missingReleasePick &&
      (albumCovers?.[missingReleasePick.releaseGroupId] || artistCoverImage)) ||
    "";
  const gradientColors = useImageGradientColors(coverSrc);
  const [tracks, setTracks] = useState([]);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [showAllTracks, setShowAllTracks] = useState(false);
  useEffect(() => {
    const releaseGroupId = missingReleasePick?.releaseGroupId;
    const releaseGroup = missingReleasePick?.releaseGroup;
    if (!releaseGroupId) {
      setTracks([]);
      setLoadingTracks(false);
      return;
    }

    let cancelled = false;
    setLoadingTracks(true);
    setTracks([]);
    getReleaseGroupTracks(releaseGroupId, {
      artistMbid: artist?.id || "",
      artistName: artist?.name || "",
      albumTitle: missingReleasePick?.title || releaseGroup?.title || "",
      releaseType: missingReleasePick?.type || releaseGroup?.["primary-type"] || "",
      releaseDate: releaseGroup?.["first-release-date"] || "",
      deezerAlbumId: releaseGroup?._deezerAlbumId || "",
    })
      .then((nextTracks) => {
        if (!cancelled) setTracks(Array.isArray(nextTracks) ? nextTracks : []);
      })
      .catch(() => {
        if (!cancelled) setTracks([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTracks(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    artist?.id,
    artist?.name,
    missingReleasePick?.releaseGroup,
    missingReleasePick?.releaseGroupId,
    missingReleasePick?.title,
    missingReleasePick?.type,
  ]);

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
        { album: missingReleasePick?.title || "" },
      ),
    [artist?.name, artistName, missingReleasePick?.title],
  );

  const { isTrackPlaying, isTrackLoading, handlePlay } = useGlobalTrackPlayback(
    normalizeTrack,
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

  const metric =
    missingReleasePick.metric || getReleaseMetric(missingReleasePick.releaseGroup);

  return (
    <section className="artist-section">
      <div
        className={`artist-pick-panel${
          gradientColors ? " artist-pick-panel--gradient" : ""
        }`}
        style={
          gradientColors
            ? {
                "--artist-pick-gradient-top": gradientColors.top,
                "--artist-pick-gradient-bottom": gradientColors.bottom,
              }
            : undefined
        }
      >
        {gradientColors ? (
          <span className="artist-pick-panel__backdrop" aria-hidden="true">
            <span className="artist-pick-panel__backdrop-gradient" />
            <span className="artist-pick-panel__backdrop-wash" />
          </span>
        ) : null}
        <div className="artist-pick-panel__grid">
          <div className="artist-media-cell">
            <PickCover
              pick={missingReleasePick}
              albumCovers={albumCovers}
              artistCoverImage={artistCoverImage}
            />
          </div>
          <div className="artist-pick-panel__content">
            <div className="artist-min-0">
              <div className="artist-eyebrow">
                Aurral Pick
              </div>
              <h2 className="artist-pick-title">
                {missingReleasePick.title}
              </h2>
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
                <AddAlbumButton
                  className="btn-add-album is-expanded"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRequestAlbum(
                      missingReleasePick.releaseGroupId,
                      missingReleasePick.title,
                    );
                  }}
                  isLoading={requestingAlbum === missingReleasePick.releaseGroupId}
                  disabled={requestingAlbum === missingReleasePick.releaseGroupId}
                />
              </div>
            )}
          </div>
          <div className="artist-pick-panel__tracks artist-min-0">
            {loadingTracks ? (
              <div className="artist-loading">
                <Loader className="artist-spinner animate-spin" />
              </div>
            ) : tracks.length ? (
              <>
                <ArtistTrackListToolbar
                  disabled={toolbarDisabled}
                  isPlaying={isListPlaying}
                  isShuffleEnabled={isShuffleEnabled}
                  onPlayAll={handlePlayAll}
                  onShufflePlay={handleShufflePlay}
                />
                <div className="artist-pick-panel__track-grid">
                {visibleTracks.map((track, index) => {
                  const currentTrackId = String(
                    track.id ?? track.mbid ?? `pick-${index}`,
                  );
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
                          onClick={(event) =>
                            handleTrackPreviewPlay(track, index, event)
                          }
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
                              ? resolveMembershipTrack(
                                  track,
                                  missingReleasePick.releaseGroup,
                                )
                              : track
                          }
                          playlists={playlists}
                          loading={playlistsLoading}
                          saving={playlistSavingKey === currentTrackId}
                          error={playlistError}
                          defaultNewPlaylistName={getDefaultPlaylistName?.(
                            track,
                            missingReleasePick.releaseGroup,
                          )}
                          onLoadPlaylists={onLoadPlaylists}
                          onSelect={(target) =>
                            onAddTrackToPlaylist(
                              track,
                              missingReleasePick.releaseGroup,
                              target,
                            )
                          }
                        />
                      ) : null}
                      <span className="artist-track-duration">
                        {formatDuration(track)}
                      </span>
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
                    {showAllTracks
                      ? "Show fewer tracks"
                      : `Show all ${tracks.length} tracks`}
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

ArtistDetailsDownloadTargets.propTypes = {
  releaseGroups: PropTypes.arrayOf(PropTypes.object),
  getAlbumStatus: PropTypes.func.isRequired,
  artist: PropTypes.object,
  albumCovers: PropTypes.object,
  artistCoverImage: PropTypes.string,
  canAddAlbum: PropTypes.bool,
  requestingAlbum: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  handleRequestAlbum: PropTypes.func.isRequired,
  artistName: PropTypes.string,
  playbackSource: PropTypes.shape({
    type: PropTypes.string,
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    label: PropTypes.string,
  }),
  onAddTrackToPlaylist: PropTypes.func,
  playlists: PropTypes.array,
  playlistsLoading: PropTypes.bool,
  playlistSavingKey: PropTypes.string,
  playlistError: PropTypes.string,
  getDefaultPlaylistName: PropTypes.func,
  onLoadPlaylists: PropTypes.func,
};
