import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Loader, Pause, Play } from "lucide-react";
import { getArtistTopSongVideo } from "../../../utils/api";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";

export function ArtistDetailsPreviewTracks({
  mbid,
  artistName,
  loadingPreview,
  previewTracks,
  playingPreviewId,
  isArtistPlaybackActive,
  handlePreviewPlay,
  onAddTrackToPlaylist,
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistError,
  getDefaultPlaylistName,
  onLoadPlaylists,
}) {
  const topTrack = useMemo(
    () => (Array.isArray(previewTracks) ? previewTracks[0] : null),
    [previewTracks],
  );
  const [topSongVideo, setTopSongVideo] = useState(null);
  const [loadingVideo, setLoadingVideo] = useState(false);

  useEffect(() => {
    const trackTitle = topTrack?.title;
    if (!mbid || !artistName || !trackTitle) {
      setTopSongVideo(null);
      setLoadingVideo(false);
      return;
    }

    const controller = new AbortController();
    setLoadingVideo(true);
    setTopSongVideo(null);

    getArtistTopSongVideo(mbid, artistName, trackTitle, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          setTopSongVideo(data?.video || null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTopSongVideo(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingVideo(false);
        }
      });

    return () => controller.abort();
  }, [artistName, mbid, topTrack?.title]);

  if (!loadingPreview && (!previewTracks || previewTracks.length === 0)) {
    return null;
  }

  const showVideoPanel = loadingVideo || topSongVideo?.embedUrl;
  const embedSrc = topSongVideo?.embedUrl
    ? `${topSongVideo.embedUrl}?rel=0&modestbranding=1`
    : "";

  return (
    <section className="artist-section">
      <h2 className="artist-section-title">Popular</h2>
      {loadingPreview ? (
        <div className="artist-loading">
          <Loader className="artist-spinner animate-spin" />
        </div>
      ) : (
        <div
          className={
            showVideoPanel
              ? "artist-preview-layout artist-preview-layout--with-video"
              : "artist-preview-layout"
          }
        >
          <div className="artist-preview-list">
            {previewTracks.map((track, index) => {
              const trackId = String(track.id || `${track.title}-${index}`);
              const isPlaying =
                isArtistPlaybackActive &&
                String(playingPreviewId) === trackId;
              return (
                <div
                  key={trackId}
                  className="artist-track-row artist-track-row--preview"
                >
                  <span className="artist-track-number">
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => handlePreviewPlay(track)}
                    disabled={!track.preview_url}
                    className="btn btn-surface btn-track-play-lg"
                    aria-label={isPlaying ? "Pause preview" : "Play preview"}
                    title={isPlaying ? "Pause preview" : "Play preview"}
                  >
                    {isPlaying ? (
                      <Pause className="artist-icon-sm" />
                    ) : (
                      <Play className="artist-icon-sm" />
                    )}
                  </button>
                  <div className="artist-track-cell">
                    <p className="artist-track-title">
                      {track.title}
                    </p>
                    <p className="artist-track-subtitle">
                      {track.album || "Preview available"}
                    </p>
                  </div>
                  {onAddTrackToPlaylist ? (
                    <div className="artist-relative">
                      <TrackPlaylistMenu
                        menuVariant="preview-tracks"
                        playlists={playlists}
                        loading={playlistsLoading}
                        saving={playlistSavingKey === trackId}
                        error={playlistError}
                        defaultNewPlaylistName={getDefaultPlaylistName?.(track)}
                        onLoadPlaylists={onLoadPlaylists}
                        onSelect={(target) =>
                          onAddTrackToPlaylist(track, target)
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {showVideoPanel ? (
            <div className="artist-video-wrap">
              <div className="artist-video">
                {embedSrc ? (
                  <iframe
                    src={embedSrc}
                    title={`${artistName} ${topTrack?.title || ""}`}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                ) : (
                  <div className="artist-loading">
                    <Loader className="artist-spinner animate-spin" />
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

ArtistDetailsPreviewTracks.propTypes = {
  mbid: PropTypes.string,
  artistName: PropTypes.string,
  loadingPreview: PropTypes.bool,
  previewTracks: PropTypes.array,
  playingPreviewId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  isArtistPlaybackActive: PropTypes.bool,
  handlePreviewPlay: PropTypes.func.isRequired,
  onAddTrackToPlaylist: PropTypes.func,
  playlists: PropTypes.array,
  playlistsLoading: PropTypes.bool,
  playlistSavingKey: PropTypes.string,
  playlistError: PropTypes.string,
  getDefaultPlaylistName: PropTypes.func,
  onLoadPlaylists: PropTypes.func,
};
