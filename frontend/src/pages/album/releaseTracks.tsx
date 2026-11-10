import { useCallback, useMemo } from "react";
import { Download, Plus } from "../../components/icons";
import { DotLoader, DownloadingIcon } from "../../components/DotLoader";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
import TooltipButton from "../../components/TooltipButton";
import type { TrackListRow } from "../../components/TrackList";
import { useAudioQueue } from "../../contexts/audioQueueContext";
import { useToast } from "../../contexts/ToastContext";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import { useAddTrackToLibrary } from "../../hooks/useAddTrackToLibrary";
import {
  useAlbumTrackListToolbar,
  type PlaybackSource,
} from "../../hooks/useAlbumTrackListToolbar";
import { useQueueTrackActions } from "../../hooks/useQueueTrackActions";
import type { ReleaseGroupTrack } from "../../utils/api/endpoints/artists.ts";
import { normalizePreviewTrack } from "../../utils/audioQueue";
import { type ReleaseGroup } from "../ArtistDetails/utils";
import { formatDuration } from "../library/libraryShared.tsx";
import { trackDownloadActionLabel } from "../../utils/trackDownloadLabel.ts";
import { releaseTrackId } from "./mergeAlbumTracks.ts";
import type { useLibraryActions } from "../library/useLibraryActions.tsx";
import { TrackPlaylistSubmenu, type PlaylistSelection } from "../../components/TrackPlaylistMenu";
import {
  buildStaticPlaylistTrackPayload,
  reserveUniquePlaylistName,
} from "../../utils/staticPlaylists.ts";

export function OwnedTrackMark() {
  return (
    <span className="native-library-track__owned">
      <SearchLibraryCheck size="discover" />
    </span>
  );
}

const hasTrackId = (ids: ReadonlySet<string> | undefined, track: ReleaseGroupTrack) =>
  Boolean(ids) && [track.mbid, track.id].some((id) => id && ids!.has(String(id)));

export const releaseTrackPayload = (
  release: ReleaseGroup | null | undefined,
  track: ReleaseGroupTrack,
  artistName: string,
  artistMbid: string | null | undefined,
) =>
  buildStaticPlaylistTrackPayload({
    artistName: artistName || "",
    trackName: track?.trackName || track?.title || "",
    albumName: release?.title || "",
    artistMbid: artistMbid || "",
    albumMbid: release?.id || "",
    releaseMbid: track?.releaseMbid,
    trackMbid: track?.mbid || track?.id || "",
    releaseYear: String(release?.["first-release-date"] || "").slice(0, 4),
    durationMs: track?.length,
    trackNumber: track?.trackNumber,
    discNumber: track?.discNumber,
    reason: null,
  });

export function useReleasePreviewQueue({
  release,
  trackKey,
  tracks,
  artistName,
  artistMbid,
  artwork,
  playbackSource,
  ownedTrackMbids,
  awaitingRelease = false,
  creditFor = () => null,
}: {
  release: ReleaseGroup | null | undefined;
  trackKey: string | undefined;
  tracks: ReleaseGroupTrack[];
  artistName: string;
  artistMbid: string | null | undefined;
  artwork: string | null | undefined;
  playbackSource: PlaybackSource | null;
  ownedTrackMbids?: readonly string[];
  awaitingRelease?: boolean;
  creditFor?: (track: ReleaseGroupTrack) => string | null;
}) {
  const ownedIds = useMemo(() => new Set((ownedTrackMbids || []).map(String)), [ownedTrackMbids]);
  const isOwned = useCallback(
    (track: ReleaseGroupTrack) => hasTrackId(ownedIds, track),
    [ownedIds],
  );
  const normalizeTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) =>
      normalizePreviewTrack(
        {
          id: releaseTrackId(track, trackKey, index),
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        creditFor(track) || artistName,
        {
          album: release?.title || "",
          artwork: artwork || null,
          artistMbid: artistMbid || undefined,
          albumMbid: release?.id || "",
          trackMbid: track?.mbid || null,
          durationMs: track?.length ?? null,
          download:
            awaitingRelease || isOwned(track)
              ? null
              : releaseTrackPayload(release, track, artistName, artistMbid),
        },
      ),
    [artistMbid, artistName, artwork, awaitingRelease, creditFor, isOwned, release, trackKey],
  );
  const getQueueTracks = useCallback(
    () =>
      (tracks || [])
        .map((track, index) => (track?.preview_url ? normalizeTrack(track, index) : null))
        .filter((track) => track !== null),
    [normalizeTrack, tracks],
  );
  const toolbar = useAlbumTrackListToolbar({ getQueueTracks, playbackSource });
  const { currentTrack, isPlaying, isLoading, isStarting, playTrack, togglePlayPause } =
    useAudioQueue();
  const previewTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) => {
      const normalized = normalizeTrack(track, index);
      if (!normalized?.src) return;
      if (currentTrack?.id === normalized.id) {
        togglePlayPause();
        return;
      }
      playTrack(normalized, { source: playbackSource, queue: getQueueTracks() });
    },
    [currentTrack?.id, getQueueTracks, normalizeTrack, playTrack, playbackSource, togglePlayPause],
  );
  const previewPlayback = (track: ReleaseGroupTrack, index: number) => {
    const isCurrent = currentTrack?.id === releaseTrackId(track, trackKey, index);
    return {
      active: isCurrent,
      playing: isCurrent && (isPlaying || isStarting),
      loading: isCurrent && isLoading,
      onPlay: track.preview_url ? () => previewTrack(track, index) : null,
      previewOnly: Boolean(track.preview_url),
    };
  };
  return {
    ...toolbar,
    trackKey,
    normalizeTrack,
    getQueueTracks,
    previewTrack,
    previewPlayback,
    isOwned,
    awaitingRelease,
    creditFor,
  };
}

export function useReleaseTracks({
  release,
  artistName,
  artistMbid,
  preview,
  playbackSource,
  albumDownloading,
  playlists,
}: {
  release: ReleaseGroup;
  artistName: string;
  artistMbid: string | null;
  preview: ReturnType<typeof useReleasePreviewQueue>;
  playbackSource: PlaybackSource;
  albumDownloading: boolean;
  playlists: ReturnType<typeof useLibraryActions>;
}) {
  const { awaitingRelease, isOwned: isOwnedReleaseTrack } = preview;
  const { showError } = useToast();
  const { isTrackDownloading } = useActiveDownloads();
  const getQueueItems = useQueueTrackActions();
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();

  const defaultPlaylistName = reserveUniquePlaylistName(
    playlists.staticPlaylists,
    `${artistName || "Artist"} Picks`,
  );

  const buildReleaseTrackRow = (
    track: ReleaseGroupTrack,
    index: number,
    { key, number }: { key: string; number: number },
  ): TrackListRow => {
    const id = releaseTrackId(track, preview.trackKey, index);
    const title = track.title || track.trackName || "Unknown Track";
    const isOwned = isOwnedReleaseTrack(track);
    const canPlay = Boolean(track.preview_url);
    const membershipTrack = releaseTrackPayload(release, track, artistName, artistMbid);
    const downloading =
      !isOwned &&
      (albumDownloading || isTrackDownloading(track) || isTrackDownloading(membershipTrack));
    const busy = downloading || savingKeys.has(id);
    const downloadLabel = trackDownloadActionLabel(
      downloading ? "downloading" : savingKeys.has(id) ? "submitting" : null,
    );
    const queueItems = canPlay
      ? getQueueItems(preview.normalizeTrack(track, index), { source: playbackSource })
      : [];
    const items = [
      ...queueItems,
      ...(!isOwned && !awaitingRelease
        ? [
            {
              id: "add-library",
              label: downloadLabel,
              icon: downloading ? DownloadingIcon : Download,
              separatorBefore: queueItems.length > 0,
              disabled: busy,
              onSelect: () => addTrackToLibrary(membershipTrack, id),
            },
          ]
        : []),
    ];
    return {
      key,
      number,
      title,
      subtitle: preview.creditFor(track),
      time: formatDuration(track.length) || "—",
      missing: !isOwned,
      ...preview.previewPlayback(track, index),
      trailing: isOwned ? (
        <OwnedTrackMark />
      ) : awaitingRelease ? null : (
        <TooltipButton
          className="native-library-track__download"
          onClick={() => void addTrackToLibrary(membershipTrack, id)}
          disabled={busy}
          label={downloadLabel}
          aria-label={`${downloadLabel}: ${title}`}
        >
          {busy ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
        </TooltipButton>
      ),
      menu: {
        items,
        ...(items.at(-1) && { additionalItemsAfter: items.at(-1)?.id }),
        onMenuOpen: playlists.loadStaticPlaylists,
        renderAdditionalItems: ({ closeMenu }) => (
          <>
            {items.length ? <div className="native-library-item-menu__separator" /> : null}
            <TrackPlaylistSubmenu
              label="Add to playlist"
              icon={Plus}
              track={membershipTrack}
              playlists={playlists.staticPlaylists}
              loading={playlists.playlistsLoading}
              saving={playlists.playlistSavingKey === id}
              error={playlists.playlistsError}
              defaultNewPlaylistName={defaultPlaylistName}
              onSelect={(target: PlaylistSelection) => {
                if (!membershipTrack.artistName || !membershipTrack.trackName) {
                  showError("Track details are incomplete");
                  return;
                }
                void playlists.savePlaylistTracks([membershipTrack], target, {
                  key: id,
                  label: "Track",
                  defaultName: defaultPlaylistName,
                });
              }}
              onClose={closeMenu}
              toggleOnClick
            />
          </>
        ),
      },
    };
  };

  return { buildReleaseTrackRow };
}
