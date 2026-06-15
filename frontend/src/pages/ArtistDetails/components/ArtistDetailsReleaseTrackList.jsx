import { useCallback, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Loader } from "lucide-react";
import { TrackPlayButton } from "./TrackPlayButton";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";
import { ArtistTrackListToolbar } from "./ArtistTrackListToolbar";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useGlobalTrackPlayback } from "../../../hooks/useGlobalTrackPlayback";
import { normalizePreviewTrack } from "../../../utils/audioQueue";

export function ArtistDetailsReleaseTrackList({
  release,
  trackKey,
  tracks,
  loading,
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
  highlightTrackId = null,
}) {
  const rowRefs = useRef({});
  const normalizeTrack = useCallback(
    (track, index) =>
      normalizePreviewTrack(
        {
          id: track?.id ?? track?.mbid ?? `${trackKey}-${index}`,
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        artistName,
        { album: release?.title || "" },
      ),
    [artistName, release?.title, trackKey],
  );

  const { isTrackPlaying, isTrackLoading, handlePlay } = useGlobalTrackPlayback(
    (track, index) => normalizeTrack(track, index),
  );

  const getQueueTracks = useCallback(
    () =>
      (tracks || [])
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
    const queue = (tracks || [])
      .filter((entry) => entry?.preview_url)
      .map((entry, entryIndex) => normalizeTrack(entry, entryIndex));
    handlePlay(track, { source: playbackSource, queue }, index);
  };

  useEffect(() => {
    if (!highlightTrackId || loading || !tracks?.length) return;
    const normalizedHighlight = String(highlightTrackId);
    const matchIndex = tracks.findIndex((track, index) => {
      const trackId = String(track.id ?? track.mbid ?? `${trackKey}-${index}`);
      return trackId === normalizedHighlight;
    });
    if (matchIndex < 0) return;
    const track = tracks[matchIndex];
    const trackId = String(
      track.id ?? track.mbid ?? `${trackKey}-${matchIndex}`,
    );
    const row = rowRefs.current[trackId];
    if (!row) return;
    row.classList.add("is-search-focused");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timeout = window.setTimeout(() => {
      row.classList.remove("is-search-focused");
    }, 2400);
    return () => window.clearTimeout(timeout);
  }, [highlightTrackId, loading, trackKey, tracks]);

  if (!release) return null;

  return (
    <div className="artist-release-track-list">
      {loading ? (
        <div className="artist-loading">
          <Loader className="artist-spinner animate-spin" />
        </div>
      ) : tracks?.length ? (
        <>
          <ArtistTrackListToolbar
            disabled={toolbarDisabled}
            isPlaying={isListPlaying}
            isShuffleEnabled={isShuffleEnabled}
            onPlayAll={handlePlayAll}
            onShufflePlay={handleShufflePlay}
          />
          <div className="artist-track-list__rows">
          {tracks.map((track, index) => {
            const currentTrackId = String(
              track.id ?? track.mbid ?? `${trackKey}-${index}`,
            );
            const isPlaying = isTrackPlaying(currentTrackId);
            const isLoadingPreview = isTrackLoading(currentTrackId);
            const durationLabel = track.length
              ? `${Math.floor(track.length / 60000)}:${Math.floor(
                  (track.length % 60000) / 1000,
                )
                  .toString()
                  .padStart(2, "0")}`
              : "";
            return (
              <div
                key={currentTrackId}
                ref={(node) => {
                  if (node) rowRefs.current[currentTrackId] = node;
                }}
                className="artist-track-row"
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
                        ? resolveMembershipTrack(track, release)
                        : track
                    }
                    playlists={playlists}
                    loading={playlistsLoading}
                    saving={playlistSavingKey === currentTrackId}
                    error={playlistError}
                    defaultNewPlaylistName={getDefaultPlaylistName?.(
                      track,
                      release,
                    )}
                    onLoadPlaylists={onLoadPlaylists}
                    onSelect={(target) =>
                      onAddTrackToPlaylist(track, release, target)
                    }
                  />
                ) : null}
                <span className="artist-track-duration">
                  {durationLabel}
                </span>
              </div>
            );
          })}
          </div>
        </>
      ) : (
        <p className="artist-empty-message">No tracks available</p>
      )}
    </div>
  );
}

ArtistDetailsReleaseTrackList.propTypes = {
  release: PropTypes.object,
  trackKey: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  tracks: PropTypes.array,
  loading: PropTypes.bool,
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
  highlightTrackId: PropTypes.string,
};
