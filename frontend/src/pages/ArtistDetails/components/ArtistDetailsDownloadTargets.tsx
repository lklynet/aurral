import ArtworkImage from "../../../components/ArtworkImage";
import { getAlbumAddAction } from "../../../utils/albumAddAction";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import AddActionButton from "../../../components/AddActionButton";
import {
  CollectionHeader,
  CollectionPlayButtons,
  useCollectionTint,
} from "../../../components/CollectionHeader";
import { OptionalLink } from "../../../components/RouteLink";
import TooltipButton from "../../../components/TooltipButton";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { useShareAction } from "../../../hooks/useShareAction";
import { getReleaseGroupTracks } from "../../../utils/api/endpoints/artists.ts";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import {
  buildAurralPick,
  buildReleaseHeaderMeta,
  getReleaseGroupCoverUrl,
  mergeReleaseDetails,
} from "../utils";
import { TrackPlaylistMenu } from "./TrackPlaylistMenu";
import { TrackPlayButton } from "./TrackPlayButton";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { normalizePreviewTrack } from "../../../utils/audioQueue";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import { queryKeys } from "../../../queryClient.ts";
import { releaseGroupDetailsQueryOptions } from "../../../queryOptions.ts";
import type { ReleaseGroupTrack } from "../../../../../backend/routes/artists/handlers/releaseGroup.ts";
import type { ArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary.ts";
import type { ArtistDetails } from "../hooks/useArtistDetailsStream.ts";
import type { useLibraryDestination } from "../../../hooks/useLibraryDestination.ts";
import type { PlaybackSource } from "../../../hooks/useAlbumTrackListToolbar.ts";
import type { PlaylistSelection, PlaylistTrackIdentity, SharedPlaylist } from "./TrackPlaylistMenu";
import type { ReleaseGroup } from "../utils";

type ArtistDetailsDownloadTargetsProps = {
  releaseGroups?: ReleaseGroup[];
  getAlbumStatus: ArtistDetailsLibrary["getAlbumStatus"];
  artist: ArtistDetails | null;
  albumCovers: Record<string, string>;
  fulfilledCoverIds: ReadonlySet<unknown> | undefined;
  artistCoverImage: string | null | undefined;
  canAddAlbum: boolean;
  requestingAlbum: string | null;
  handleRequestAlbum: ArtistDetailsLibrary["handleRequestAlbum"];
  libraryDestination: ReturnType<typeof useLibraryDestination>;
  artistName?: string;
  playbackSource?: PlaybackSource | null;
  onAddTrackToPlaylist?: (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
    target: PlaylistSelection,
  ) => void | Promise<void>;
  onAddTrackToLibrary?: (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
    key: string,
  ) => unknown;
  libraryTrackSavingKeys?: Set<string>;
  resolveMembershipTrack?: (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
  ) => PlaylistTrackIdentity;
  playlists?: SharedPlaylist[];
  playlistsLoading?: boolean;
  playlistSavingKey?: string;
  playlistError?: string;
  getDefaultPlaylistName?: (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
  ) => string;
  onLoadPlaylists?: () => Promise<unknown>;
};

const formatDuration = (track: Pick<ReleaseGroupTrack, "length"> & { duration_ms?: number }) => {
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
  libraryDestination,
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
}: ArtistDetailsDownloadTargetsProps) {
  const [requestedPick, setRequestedPick] = useState<{
    artistId: string | undefined;
    releaseGroupId: string;
  } | null>(null);
  const requestedReleaseGroupId =
    requestedPick?.artistId === artist?.id ? requestedPick!.releaseGroupId : null;
  const missingReleasePick = useMemo(
    () => buildAurralPick({ releaseGroups, getAlbumStatus, requestedReleaseGroupId }),
    [releaseGroups, getAlbumStatus, requestedReleaseGroupId],
  );
  const [showAllTracks, setShowAllTracks] = useState(false);
  const { isAlbumDownloading } = useActiveDownloads();
  const share = useShareAction();
  const releaseGroup = missingReleasePick?.releaseGroup;
  const releaseDetailsQuery = useQuery(
    releaseGroupDetailsQueryOptions(missingReleasePick?.releaseGroupId),
  );
  const release = useMemo(
    () => mergeReleaseDetails(releaseGroup, releaseDetailsQuery.data),
    [releaseGroup, releaseDetailsQuery.data],
  );
  const trackContext = useMemo(
    () => ({
      artistMbid: artist?.id || "",
      artistName: artist?.name || "",
      albumTitle: missingReleasePick?.title || releaseGroup?.title || "",
      releaseType: missingReleasePick?.type || releaseGroup?.["primary-type"] || "",
      releaseDate: releaseGroup?.["first-release-date"] || "",
      deezerAlbumId: releaseGroup?._deezerAlbumId || "",
    }),
    [artist?.id, artist?.name, missingReleasePick?.title, missingReleasePick?.type, releaseGroup],
  );
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(missingReleasePick?.releaseGroupId, trackContext),
    queryFn: ({ signal }) =>
      getReleaseGroupTracks(missingReleasePick!.releaseGroupId, { ...trackContext, signal }),
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
  const pickCover = getReleaseGroupCoverUrl(releaseGroup, albumCovers);
  const coverUrl = getReleaseGroupCoverUrl(releaseGroup, albumCovers, {
    artistFallback: artistCoverImage,
    resolved: fulfilledCoverIds?.has(missingReleasePick?.releaseGroupId),
  });
  const tint = useCollectionTint(coverUrl);

  const normalizeTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) =>
      normalizePreviewTrack(
        {
          id: track?.id ?? track?.mbid ?? `pick-${index}`,
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        artistName || artist?.name || "",
        {
          album: missingReleasePick?.title || "",
          artwork: pickCover || null,
          artistMbid: artist?.id || "",
          albumMbid: missingReleasePick?.releaseGroupId || "",
        },
      ),
    [
      artist?.id,
      artist?.name,
      artistName,
      missingReleasePick?.releaseGroupId,
      missingReleasePick?.title,
      pickCover,
    ],
  );

  const { currentTrack, isPlaying, isLoading, playTrack, togglePlayPause, source } =
    useAudioQueue();
  const getQueueItems = useQueueTrackActions();

  const handlePlay = useCallback(
    (
      track: ReleaseGroupTrack,
      options: Parameters<typeof playTrack>[1] = {},
      ...normalizeArgs: [index: number]
    ) => {
      const normalized = normalizeTrack(track, ...normalizeArgs);
      if (!normalized?.src) return;
      if (currentTrack?.id === normalized.id) {
        togglePlayPause();
        return;
      }
      playTrack(normalized, {
        source: options.source ?? source,
        queue: options.queue,
      });
    },
    [currentTrack?.id, normalizeTrack, playTrack, source, togglePlayPause],
  );

  const isTrackPlaying = useCallback(
    (trackId: string) =>
      !!trackId && currentTrack?.id === String(trackId) && (isPlaying || isLoading),
    [currentTrack?.id, isLoading, isPlaying],
  );

  const isTrackLoading = useCallback(
    (trackId: string) => !!trackId && currentTrack?.id === String(trackId) && isLoading,
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

  const handleTrackPreviewPlay = (
    track: ReleaseGroupTrack,
    index: number,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!track?.preview_url) return;
    const queue = tracks
      .filter((entry) => entry?.preview_url)
      .map((entry, entryIndex) => normalizeTrack(entry, entryIndex));
    handlePlay(track, { source: playbackSource, queue }, index);
  };

  if (!missingReleasePick) return null;

  const releaseGroupId = missingReleasePick.releaseGroupId;
  const title = release!.title || missingReleasePick.title;
  const displayArtistName = artistName || artist?.name || "";
  const { typeLabel, meta } = buildReleaseHeaderMeta(release!, tracks);
  const titleLink = getReleaseGroupLink(releaseGroup, {
    artistMbid: artist?.id,
    artistName: displayArtistName,
    coverUrl,
  });
  const albumStatus = getAlbumStatus(releaseGroupId);
  const albumBusy = requestingAlbum === releaseGroupId || isAlbumDownloading(releaseGroupId);

  return (
    <section className="artist-section">
      <div className="artist-pick-panel" style={tint ? { "--collection-tint": tint } : undefined}>
        <div className="artist-pick-panel__grid">
          <CollectionHeader
            embedded
            cover={
              coverUrl ? (
                <ArtworkImage src={coverUrl} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className="native-library-cover-fallback" aria-hidden="true">
                  {title.trim().charAt(0).toUpperCase() || "—"}
                </span>
              )
            }
            kicker={typeLabel || "Release"}
            title={<OptionalLink link={titleLink}>{title}</OptionalLink>}
            meta={meta}
            actions={
              <>
                <CollectionPlayButtons
                  label={`${title} previews`}
                  disabled={toolbarDisabled}
                  isPlaying={isListPlaying}
                  isShuffleEnabled={isShuffleEnabled}
                  onPlay={handlePlayAll}
                  onShuffle={handleShufflePlay}
                />
                {canAddAlbum && releaseGroupId ? (
                  <AddActionButton
                    {...getAlbumAddAction({ ...albumStatus }, libraryDestination)}
                    ownerConflict={albumStatus?.ownerConflict}
                    onAdd={(managedBy) => {
                      setRequestedPick({ artistId: artist?.id, releaseGroupId });
                      handleRequestAlbum(releaseGroupId, title, managedBy);
                    }}
                    isLoading={albumBusy}
                    loadingLabel="Downloading"
                    disabled={albumBusy}
                  />
                ) : null}
                <TooltipButton
                  className="native-library-favorite"
                  onClick={() =>
                    share(
                      {
                        kind: "album",
                        albumMbid: releaseGroupId,
                        artistMbid: artist?.id,
                        title,
                        artistName: displayArtistName,
                        tracks: tracks.map((track) => ({
                          title: track.title,
                          artistName: displayArtistName,
                          albumTitle: title,
                          artistMbid: artist?.id,
                          albumMbid: releaseGroupId,
                          trackMbid: track.mbid,
                          releaseMbid: track.releaseMbid,
                          durationMs: track.length,
                          trackNumber: track.trackNumber,
                          discNumber: track.discNumber,
                        })),
                      },
                      title,
                    )
                  }
                  disabled={!displayArtistName || !releaseGroup?.title}
                  label="Share album"
                >
                  <Share aria-hidden="true" />
                </TooltipButton>
              </>
            }
          />
          {loadingTracks || tracks.length ? (
            <div className="artist-min-0">
              {loadingTracks ? (
                <div className="artist-loading">
                  <DotLoader size="xl" label={null} />
                </div>
              ) : (
                <>
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
                          {onAddTrackToPlaylist || track.preview_url ? (
                            <TrackPlaylistMenu
                              queueItems={
                                track.preview_url
                                  ? getQueueItems(normalizeTrack(track, index), {
                                      source: playbackSource,
                                    })
                                  : []
                              }
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
                              onSelect={
                                onAddTrackToPlaylist
                                  ? (target) =>
                                      onAddTrackToPlaylist(
                                        track,
                                        missingReleasePick.releaseGroup,
                                        target,
                                      )
                                  : undefined
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
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
