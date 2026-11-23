import { useState } from "react";
import { TrackPlaylistMenu } from "../../../components/TrackPlaylistMenu";
import type {
  PlaylistSelection,
  PlaylistTrackIdentity,
} from "../../../components/TrackPlaylistMenu";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import { resolveAuthenticatedApiAssetUrl } from "../../../utils/api/core.ts";
import { normalizePreviewTrack } from "../../../utils/audioQueue";
import type { ArtistPreviewTrack } from "../hooks/usePreviewPlayer";
import type { useStaticPlaylists } from "../../../hooks/useStaticPlaylists";
import { DotLoader } from "../../../components/DotLoader";
import { ArtistTrackRow, formatTrackDuration } from "./ArtistTrackRow";

export const POPULAR_TRACK_LIMIT = 5;

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
  onAddTrackToLibrary?: (track: ArtistPreviewTrack, trackKey: string) => unknown;
  libraryTrackSavingKeys: ReadonlySet<string> | undefined;
  resolveMembershipTrack?: (track: ArtistPreviewTrack) => PlaylistTrackIdentity;
  playlists: ReturnType<typeof useStaticPlaylists>["staticPlaylists"];
  playlistsLoading: boolean;
  playlistSavingKey: string;
  playlistError: string;
  getDefaultPlaylistName?: (track: ArtistPreviewTrack) => string;
  onLoadPlaylists: () => Promise<unknown>;
}) {
  const [expandedMbid, setExpandedMbid] = useState<string | null>(null);
  const expanded = expandedMbid === mbid;
  const canExpand = previewTracks.length > POPULAR_TRACK_LIMIT;
  const popularTracks = expanded ? previewTracks : previewTracks.slice(0, POPULAR_TRACK_LIMIT);
  const getQueueItems = useQueueTrackActions();

  if (!loadingPreview && previewTracks.length === 0) {
    return null;
  }

  return (
    <section className="artist-section artist-popular">
      <div className="artist-section-head">
        <h2 className="artist-section-title">Popular</h2>
        {!loadingPreview && canExpand ? (
          <button
            type="button"
            className="section-show-all"
            aria-expanded={expanded}
            onClick={() => setExpandedMbid(expanded ? null : mbid)}
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      {loadingPreview ? (
        <div className="artist-loading">
          <DotLoader size="xl" label={null} />
        </div>
      ) : (
        <div className="artist-tracks" role="list" aria-label="Popular tracks">
          {popularTracks.map((track, index) => {
            const trackId = String(track.id || `${track.title}-${index}`);
            const active = String(playingPreviewId) === trackId;
            return (
              <ArtistTrackRow
                key={trackId}
                number={index + 1}
                title={track.title}
                subtitle={track.album || null}
                artwork={resolveAuthenticatedApiAssetUrl(track.artworkUrl) || null}
                duration={formatTrackDuration(track.duration_ms)}
                active={active}
                playing={active && isArtistPlaybackActive}
                previewOnly={Boolean(track.preview_url)}
                onPlay={track.preview_url ? () => handlePreviewPlay(track) : null}
                menu={
                  onAddTrackToPlaylist || track.preview_url ? (
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
                        onAddTrackToLibrary ? () => onAddTrackToLibrary(track, trackId) : null
                      }
                      onSelect={
                        onAddTrackToPlaylist
                          ? (target: PlaylistSelection) => onAddTrackToPlaylist(track, target)
                          : undefined
                      }
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
