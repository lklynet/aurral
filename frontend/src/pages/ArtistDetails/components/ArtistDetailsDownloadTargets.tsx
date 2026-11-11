import { getAlbumAddAction } from "../../../utils/albumAddAction";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Music, Pause, Play, Share } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import AddActionButton from "../../../components/AddActionButton";
import ReleaseWaitBadge from "../../../components/ReleaseWaitBadge";
import { OptionalLink } from "../../../components/RouteLink";
import TooltipButton from "../../../components/TooltipButton";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { useShareAction } from "../../../hooks/useShareAction";
import { useReleaseGroupTracks } from "../../../hooks/useReleaseGroupTracks.ts";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import {
  buildPick,
  buildAlbumHeaderMeta,
  sumTrackDurationMs,
  getReleaseGroupCoverUrl,
  mergeReleaseDetails,
} from "../utils";
import { TrackPlaylistMenu } from "../../../components/TrackPlaylistMenu";
import { ArtistTrackRow, formatTrackDuration } from "./ArtistTrackRow";
import { useReleasePreviewQueue } from "../../album/releaseTracks.tsx";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { useQueueTrackActions } from "../../../hooks/useQueueTrackActions";
import { releaseGroupDetailsQueryOptions } from "../../../queryOptions.ts";
import type { ReleaseGroupTrack } from "../../../utils/api/endpoints/artists.ts";
import type { ArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary.ts";
import type { ArtistDetails } from "../hooks/useArtistDetails.ts";
import { ReleaseCoverImage } from "../../../components/ReleaseCoverImage";
import type { PlaybackSource } from "../../../hooks/useAlbumTrackListToolbar.ts";
import type {
  PlaylistSelection,
  PlaylistTrackIdentity,
  SharedPlaylist,
} from "../../../components/TrackPlaylistMenu";
import type { ReleaseGroup } from "../utils";

type ArtistDetailsDownloadTargetsProps = {
  releaseGroups?: ReleaseGroup[];
  getAlbumStatus: ArtistDetailsLibrary["getAlbumStatus"];
  artist: ArtistDetails | null;
  artistCoverImage: string | null | undefined;
  canAddAlbum: boolean;
  requestingAlbum: string | null;
  handleRequestAlbum: ArtistDetailsLibrary["handleRequestAlbum"];
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

const TRACK_PREVIEW_LIMIT = 4;

export function ArtistDetailsDownloadTargets({
  releaseGroups = [],
  getAlbumStatus,
  artist,
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
}: ArtistDetailsDownloadTargetsProps) {
  const [requestedPick, setRequestedPick] = useState<{
    artistId: string | undefined;
    releaseGroupId: string;
  } | null>(null);
  const requestedReleaseGroupId =
    requestedPick?.artistId === artist?.id ? requestedPick!.releaseGroupId : null;
  const missingReleasePick = useMemo(
    () => buildPick({ releaseGroups, getAlbumStatus, requestedReleaseGroupId }),
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
  const { tracks, isPending: loadingTracks } = useReleaseGroupTracks(
    missingReleasePick?.releaseGroupId,
    {
      artistMbid: artist?.id || undefined,
      deezerAlbumId: releaseGroup?._deezerAlbumId ? String(releaseGroup._deezerAlbumId) : undefined,
    },
  );

  useEffect(() => {
    setShowAllTracks(false);
  }, [missingReleasePick?.releaseGroupId]);

  const visibleTracks =
    showAllTracks || tracks.length <= TRACK_PREVIEW_LIMIT
      ? tracks
      : tracks.slice(0, TRACK_PREVIEW_LIMIT);
  const hasHiddenTracks = tracks.length > TRACK_PREVIEW_LIMIT;
  const pickCover = getReleaseGroupCoverUrl(releaseGroup);
  const coverUrl = pickCover || artistCoverImage || "";

  const pickRelease = useMemo(
    () => ({
      ...release,
      id: missingReleasePick?.releaseGroupId,
      title: missingReleasePick?.title || release?.title || "",
    }),
    [missingReleasePick?.releaseGroupId, missingReleasePick?.title, release],
  );
  const {
    normalizeTrack,
    previewTrack,
    disabled: toolbarDisabled,
    isListPlaying,
    handlePlayAll,
  } = useReleasePreviewQueue({
    release: pickRelease,
    trackKey: "pick",
    tracks,
    artistName: artistName || artist?.name || "",
    artistMbid: artist?.id,
    artwork: pickCover,
    playbackSource,
  });

  const { currentTrack, isPlaying, isLoading } = useAudioQueue();
  const getQueueItems = useQueueTrackActions();

  const isCurrentTrack = (trackId: string) => !!trackId && currentTrack?.id === trackId;

  if (!missingReleasePick) return null;

  const releaseGroupId = missingReleasePick.releaseGroupId;
  const title = release!.title || missingReleasePick.title;
  const displayArtistName = artistName || artist?.name || "";
  const meta = buildAlbumHeaderMeta({
    release,
    trackCount: tracks.length,
    durationMs: sumTrackDurationMs(tracks),
  })
    .map((segment) => segment.text)
    .join(" · ");
  const titleLink = getReleaseGroupLink(releaseGroup, {
    artistMbid: artist?.id,
    artistName: displayArtistName,
    coverUrl,
  });
  const albumStatus = getAlbumStatus(releaseGroupId);
  const albumBusy = requestingAlbum === releaseGroupId || isAlbumDownloading(releaseGroupId);

  const kind = (missingReleasePick.type || "release").toLowerCase();
  const shareAlbum = () =>
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
    );

  return (
    <section className="artist-section artist-pick" data-artwork-scope>
      <h2 className="artist-section-title">Missing from your Library</h2>
      <div className="artist-pick__head">
        <div className="artist-pick__cover" data-artwork>
          <ReleaseCoverImage
            src={pickCover}
            fallback={artistCoverImage}
            alt=""
            sizes="10rem"
            loading="lazy"
            decoding="async"
            placeholder={
              <span className="artist-pick__placeholder" aria-hidden="true">
                <Music />
              </span>
            }
          />
        </div>
        <div className="artist-pick__details">
          <h3 className="artist-pick__title">
            <OptionalLink link={titleLink}>{title}</OptionalLink>
          </h3>
          {meta ? <p className="artist-pick__meta">{meta}</p> : null}
          <p className="artist-pick__why">Most popular {kind}</p>
          <div className="artist-pick__actions">
            {albumStatus?.status === "waiting" ? (
              <ReleaseWaitBadge releaseDate={release!["first-release-date"]} />
            ) : canAddAlbum && releaseGroupId ? (
              <AddActionButton
                {...getAlbumAddAction({ releaseDate: release?.["first-release-date"] })}
                className="btn-primary"
                onAdd={() => {
                  setRequestedPick({ artistId: artist?.id, releaseGroupId });
                  handleRequestAlbum(releaseGroupId, title);
                }}
                isLoading={albumBusy}
                loadingLabel="Downloading"
                disabled={albumBusy}
              >
                {albumBusy ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
                {albumBusy ? "Downloading" : "Download"}
              </AddActionButton>
            ) : null}
            <TooltipButton
              className="btn btn-ghost btn-icon-square"
              onClick={handlePlayAll}
              disabled={toolbarDisabled}
              label={isListPlaying ? `Pause ${title} previews` : `Play ${title} previews`}
            >
              {isListPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="btn btn-ghost btn-icon-square artist-pick__share"
              onClick={shareAlbum}
              disabled={!displayArtistName || !releaseGroup?.title}
              label="Share album"
            >
              <Share aria-hidden="true" />
            </TooltipButton>
          </div>
        </div>
      </div>
      {loadingTracks ? (
        <div className="artist-loading">
          <DotLoader size="xl" label={null} />
        </div>
      ) : tracks.length ? (
        <>
          <div
            className={`artist-tracks artist-pick__tracks${showAllTracks ? " is-expanded" : ""}`}
            role="list"
            aria-label={`${title} tracks`}
          >
            {visibleTracks.map((track, index) => {
              const trackId = String(track.id ?? track.mbid ?? `pick-${index}`);
              const active = isCurrentTrack(trackId);
              return (
                <ArtistTrackRow
                  key={trackId}
                  number={track.trackNumber || track.position || index + 1}
                  title={track.title || track.trackName || "Unknown Track"}
                  duration={formatTrackDuration(track.length)}
                  active={active}
                  playing={active && (isPlaying || isLoading)}
                  loading={active && isLoading}
                  onPlay={track.preview_url ? () => previewTrack(track, index) : null}
                  menu={
                    onAddTrackToPlaylist || track.preview_url ? (
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
                        saving={playlistSavingKey === trackId}
                        librarySaving={libraryTrackSavingKeys?.has(trackId)}
                        error={playlistError}
                        defaultNewPlaylistName={getDefaultPlaylistName?.(
                          track,
                          missingReleasePick.releaseGroup,
                        )}
                        onLoadPlaylists={onLoadPlaylists}
                        onAddToLibrary={
                          onAddTrackToLibrary
                            ? () =>
                                onAddTrackToLibrary(track, missingReleasePick.releaseGroup, trackId)
                            : null
                        }
                        onSelect={
                          onAddTrackToPlaylist
                            ? (target) =>
                                onAddTrackToPlaylist(track, missingReleasePick.releaseGroup, target)
                            : undefined
                        }
                      />
                    ) : null
                  }
                />
              );
            })}
          </div>
          {hasHiddenTracks ? (
            <button
              type="button"
              className="section-show-all artist-pick__more"
              onClick={() => setShowAllTracks((current) => !current)}
            >
              {showAllTracks ? "Show fewer tracks" : `Show all ${tracks.length} tracks`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
