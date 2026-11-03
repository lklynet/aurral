import { useCallback } from "react";
import { MoreVertical, Plus } from "../../components/icons";
import { DotLoader, DownloadingIcon } from "../../components/DotLoader";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
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
import {
  buildStaticPlaylistTrackPayload,
  reserveUniquePlaylistName,
  type ReleaseGroup,
} from "../ArtistDetails/utils";
import { formatDuration } from "../library/libraryShared.tsx";
import { releaseTrackId } from "./mergeAlbumTracks.ts";
import type { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  TrackPlaylistSubmenu,
  type PlaylistSelection,
} from "../ArtistDetails/components/TrackPlaylistMenu";

export function useReleasePreviewQueue({
  release,
  trackKey,
  tracks,
  artistName,
  artistMbid,
  artwork,
  playbackSource,
}: {
  release: ReleaseGroup | null | undefined;
  trackKey: string | undefined;
  tracks: ReleaseGroupTrack[];
  artistName: string;
  artistMbid: string | null | undefined;
  artwork: string | null | undefined;
  playbackSource: PlaybackSource | null;
}) {
  const normalizeTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) =>
      normalizePreviewTrack(
        {
          id: releaseTrackId(track, trackKey, index),
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        artistName,
        {
          album: release?.title || "",
          artwork: artwork || null,
          artistMbid: artistMbid || undefined,
          albumMbid: release?.id || "",
        },
      ),
    [artistMbid, artistName, artwork, release?.id, release?.title, trackKey],
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
    };
  };
  return { ...toolbar, trackKey, normalizeTrack, getQueueTracks, previewTrack, previewPlayback };
}

export function useReleaseTracks({
  release,
  artistName,
  artistMbid,
  preview,
  playbackSource,
  albumDownloading,
  awaitingRelease = false,
  ownedTrackMbids,
  playlists,
}: {
  release: ReleaseGroup;
  artistName: string;
  artistMbid: string | null;
  preview: ReturnType<typeof useReleasePreviewQueue>;
  playbackSource: PlaybackSource;
  albumDownloading: boolean;
  /** The album waits for its release date: missing tracks can't be downloaded yet. */
  awaitingRelease?: boolean;
  ownedTrackMbids: readonly string[] | undefined;
  playlists: ReturnType<typeof useLibraryActions>;
}) {
  const { showError } = useToast();
  const { isTrackDownloading } = useActiveDownloads();
  const getQueueItems = useQueueTrackActions();
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();

  const buildReleaseTrackPayload = (track: ReleaseGroupTrack) =>
    buildStaticPlaylistTrackPayload({
      artistName: artistName || "",
      trackName: track?.trackName || track?.title || "",
      albumName: release.title || "",
      artistMbid: artistMbid || "",
      albumMbid: release.id || "",
      releaseMbid: track?.releaseMbid,
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: String(release["first-release-date"] || "").slice(0, 4),
      durationMs: track?.length,
      trackNumber: track?.trackNumber,
      discNumber: track?.discNumber,
      reason: null,
    });

  const defaultPlaylistName = reserveUniquePlaylistName(
    playlists.staticPlaylists,
    `${artistName || "Artist"} Picks`,
  );
  const ownedTrackSet = new Set((ownedTrackMbids || []).map(String));
  const isOwnedReleaseTrack = (track: ReleaseGroupTrack) =>
    [track.mbid, track.id].filter(Boolean).some((identity) => ownedTrackSet.has(String(identity)));

  const buildReleaseTrackRow = (
    track: ReleaseGroupTrack,
    index: number,
    { key, number }: { key: string; number: number },
  ): TrackListRow => {
    const id = releaseTrackId(track, preview.trackKey, index);
    const title = track.title || track.trackName || "Unknown Track";
    const isOwned = isOwnedReleaseTrack(track);
    const canPlay = Boolean(track.preview_url);
    const membershipTrack = buildReleaseTrackPayload(track);
    const downloading =
      !isOwned &&
      (albumDownloading || isTrackDownloading(track) || isTrackDownloading(membershipTrack));
    const queueItems = canPlay
      ? getQueueItems(preview.normalizeTrack(track, index), { source: playbackSource })
      : [];
    const items = [
      ...queueItems,
      ...(!isOwned && !awaitingRelease
        ? [
            {
              id: "add-library",
              label: downloading ? "Downloading…" : "Add to library",
              icon: downloading ? DownloadingIcon : Plus,
              separatorBefore: queueItems.length > 0,
              disabled: downloading || savingKeys.has(id),
              onSelect: () => addTrackToLibrary(membershipTrack, id),
            },
          ]
        : []),
    ];
    return {
      key,
      number,
      title,
      time: formatDuration(track.length) || "—",
      missing: !isOwned,
      ...preview.previewPlayback(track, index),
      badge: isOwned ? <SearchLibraryCheck size="discover" /> : null,
      menu: {
        items,
        triggerLabel: downloading ? `Downloading ${title}` : `Add ${title}`,
        triggerClassName: "btn btn-add-action btn-add-action--menu",
        triggerIcon: (
          <>
            <span className="btn-add-action__icon">
              {downloading ? <DotLoader size="sm" label={null} /> : <Plus aria-hidden="true" />}
            </span>
            <MoreVertical className="btn-add-action__more" aria-hidden="true" />
          </>
        ),
        ...(items.at(-1) ? { additionalItemsAfter: items.at(-1)?.id } : {}),
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
