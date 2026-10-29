import { useMemo } from "react";
import { ArtistDetailsVideos } from "./ArtistDetailsVideos";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";
import type { PlaylistSelection } from "./TrackPlaylistMenu";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import { normalizePreviewTrack } from "../../../utils/audioQueue";
import type { ArtistPreviewTrack } from "../hooks/usePreviewPlayer";
import type { useStaticPlaylists } from "../../../hooks/useStaticPlaylists";
import { Pause, Play } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import TooltipButton from "../../../components/TooltipButton";
export function ArtistDetailsPreviewTracks({
  mbid,
  artistName,
  loadingPreview,
  previewTracks,
  playingPreviewId,
  isArtistPlaybackActive,
  handlePreviewPlay,
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
}: {
  mbid: string;
  artistName: string;
  loadingPreview: boolean;
  previewTracks: ArtistPreviewTrack[];
  playingPreviewId: string | number | null;
  isArtistPlaybackActive: boolean;
  handlePreviewPlay: (track: ArtistPreviewTrack) => void;
  onAddTrackToPlaylist?: (track: ArtistPreviewTrack, target: PlaylistSelection) => void;
  onAddTrackToLibrary?: (track: ArtistPreviewTrack, releaseGroup: null, trackKey: string) => void;
  libraryTrackSavingKeys: ReadonlySet<string> | undefined;
  resolveMembershipTrack?: (track: ArtistPreviewTrack) => unknown;
  playlists: ReturnType<typeof useStaticPlaylists>["staticPlaylists"];
  playlistsLoading: boolean;
  playlistSavingKey: string;
  playlistError: string;
  getDefaultPlaylistName?: (track: ArtistPreviewTrack) => string;
  onLoadPlaylists: () => Promise<unknown>;
}) {
  const popularTracks = useMemo(() => (previewTracks || []).slice(0, 6), [previewTracks]);
  const getQueueItems = useQueueTrackActions();

  if (!loadingPreview && (!previewTracks || previewTracks.length === 0)) {
    return null;
  }

  return (
    <>
      <section className="artist-section">
        <h2 className="artist-section-title">Popular</h2>
        {loadingPreview ? (
          <div className="artist-loading">
            <DotLoader size="xl" label={null} />
          </div>
        ) : (
          <div className="artist-preview-list">
            {popularTracks.map((track, index) => {
              const trackId = String(track.id || `${track.title}-${index}`);
              const isPlaying = isArtistPlaybackActive && String(playingPreviewId) === trackId;
              return (
                <div
                  key={trackId}
                  className={`artist-track-row artist-track-row--preview${isPlaying ? " is-active" : ""}`}
                >
                  <span className="artist-track-number">{index + 1}</span>
                  <TooltipButton
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
                  </TooltipButton>
                  {track.artworkUrl ? (
                    <img
                      className="artist-track-thumb"
                      src={track.artworkUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span className="artist-track-thumb" aria-hidden="true" />
                  )}
                  <div className="artist-track-cell">
                    <p className="artist-track-title">{track.title}</p>
                    <p className="artist-track-subtitle">{track.album || "Preview available"}</p>
                  </div>
                  {onAddTrackToPlaylist || track.preview_url ? (
                    <div className="artist-relative">
                      <TrackPlaylistMenu
                        queueItems={
                          track.preview_url
                            ? getQueueItems(
                                normalizePreviewTrack(track, artistName, { artistMbid: mbid }),
                                { source: { type: "artist-all", id: mbid, label: artistName } },
                              )
                            : []
                        }
                        track={resolveMembershipTrack ? resolveMembershipTrack(track) : track}
                        menuVariant="preview-tracks"
                        triggerVariant="kebab"
                        playlists={playlists}
                        loading={playlistsLoading}
                        saving={playlistSavingKey === trackId}
                        librarySaving={libraryTrackSavingKeys?.has(trackId)}
                        error={playlistError}
                        defaultNewPlaylistName={getDefaultPlaylistName?.(track)}
                        onLoadPlaylists={onLoadPlaylists}
                        onAddToLibrary={
                          onAddTrackToLibrary
                            ? () => onAddTrackToLibrary(track, null, trackId)
                            : null
                        }
                        onSelect={
                          onAddTrackToPlaylist
                            ? (target: PlaylistSelection) => onAddTrackToPlaylist(track, target)
                            : undefined
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {!loadingPreview && popularTracks.length > 0 ? (
        <ArtistDetailsVideos mbid={mbid} artistName={artistName} tracks={popularTracks} />
      ) : null}
    </>
  );
}
