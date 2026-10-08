import { useCallback } from "react";
import { MoreVertical, Plus } from "lucide-react";
import { DotLoader, DownloadingIcon } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import { TrackList } from "../../../components/TrackList";
import { TrackPlaylistSubmenu } from "./TrackPlaylistMenu";
import { useAlbumTrackListToolbar } from "../../../hooks/useAlbumTrackListToolbar";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { normalizePreviewTrack } from "../../../utils/audioQueue";

const releaseTrackId = (track, trackKey, index) =>
  String(track?.id ?? track?.mbid ?? `${trackKey}-${index}`);

const formatReleaseTrackDuration = (length) =>
  length
    ? `${Math.floor(length / 60000)}:${Math.floor((length % 60000) / 1000)
        .toString()
        .padStart(2, "0")}`
    : "—";

export function useReleasePreviewQueue({ release, trackKey, tracks, artistName, artistMbid, artwork, playbackSource }) {
  const normalizeTrack = useCallback(
    (track, index) =>
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
          artistMbid,
          albumMbid: release?.id || trackKey,
        },
      ),
    [artistMbid, artistName, artwork, release?.id, release?.title, trackKey],
  );
  const getQueueTracks = useCallback(
    () =>
      (tracks || [])
        .map((track, index) => (track?.preview_url ? normalizeTrack(track, index) : null))
        .filter(Boolean),
    [normalizeTrack, tracks],
  );
  const toolbar = useAlbumTrackListToolbar({ getQueueTracks, playbackSource });
  return { ...toolbar, normalizeTrack, getQueueTracks };
}

export function ArtistDetailsReleaseTrackList({
  release,
  trackKey,
  tracks,
  loading,
  preview,
  playbackSource = null,
  onAddTrackToPlaylist,
  onAddTrackToLibrary,
  libraryTrackSavingKey,
  albumDownloading = false,
  ownedTrackMbids = [],
  resolveMembershipTrack,
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistError,
  getDefaultPlaylistName,
  onLoadPlaylists,
  highlightTrackId = null,
}) {
  const ownedTrackSet = new Set((Array.isArray(ownedTrackMbids) ? ownedTrackMbids : []).map(String));
  const { currentTrack, isPlaying, isLoading, playTrack, togglePlayPause } = useAudioQueue();
  const { isTrackDownloading } = useActiveDownloads();

  if (!release) return null;
  if (loading) {
    return (
      <div className="native-library-state" role="status">
        <DotLoader size="lg" label={null} />
        <span>Loading tracks…</span>
      </div>
    );
  }
  if (!tracks?.length) {
    return (
      <div className="native-library-state">
        <span>No tracks available</span>
      </div>
    );
  }

  const handlePlay = (track, index) => {
    const normalized = preview.normalizeTrack(track, index);
    if (!normalized?.src) return;
    if (currentTrack?.id === normalized.id) {
      togglePlayPause();
      return;
    }
    playTrack(normalized, { source: playbackSource, queue: preview.getQueueTracks() });
  };

  const rows = tracks.map((track, index) => {
    const id = releaseTrackId(track, trackKey, index);
    const title = track.title || track.trackName || "Unknown Track";
    const isCurrent = currentTrack?.id === id;
    const isOwned = [track.mbid, track.recordingId, track.id]
      .filter(Boolean)
      .some((identity) => ownedTrackSet.has(String(identity)));
    const canPlay = Boolean(track.preview_url);
    const membershipTrack = resolveMembershipTrack ? resolveMembershipTrack(track, release) : track;
    const downloading =
      !isOwned &&
      (albumDownloading || isTrackDownloading(track) || isTrackDownloading(membershipTrack));
    const items = [
      ...(onAddTrackToLibrary && !isOwned
        ? [
            {
              id: "add-library",
              label: downloading ? "Downloading…" : "Add to library",
              icon: downloading ? DownloadingIcon : Plus,
              disabled: downloading || libraryTrackSavingKey === id,
              onSelect: () => onAddTrackToLibrary(track, release),
            },
          ]
        : []),
    ];
    return {
      key: id,
      number: track.trackNumber || track.position || index + 1,
      title,
      time: formatReleaseTrackDuration(track.length),
      active: isCurrent,
      playing: isCurrent && (isPlaying || isLoading),
      onPlay: canPlay ? () => handlePlay(track, index) : null,
      badge: isOwned ? <SearchLibraryCheck size="discover" /> : null,
      menu: items.length || onAddTrackToPlaylist ? {
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
        ...(items.length ? { additionalItemsAfter: items[items.length - 1].id } : {}),
        onMenuOpen: onLoadPlaylists,
        renderAdditionalItems: onAddTrackToPlaylist
          ? ({ closeMenu }) => (
              <>
                {items.length ? <div className="native-library-item-menu__separator" /> : null}
                <TrackPlaylistSubmenu
                  label="Add to playlist"
                  icon={Plus}
                  track={membershipTrack}
                  playlists={playlists}
                  loading={playlistsLoading}
                  saving={playlistSavingKey === id}
                  error={playlistError}
                  defaultNewPlaylistName={getDefaultPlaylistName?.(track, release)}
                  onSelect={(target) => onAddTrackToPlaylist(track, release, target)}
                  onClose={closeMenu}
                  toggleOnClick
                />
              </>
            )
          : undefined,
      } : undefined,
    };
  });

  return (
    <TrackList
      label={`${release.title || "Release"} tracks`}
      rows={rows}
      variant="release"
      highlightKey={highlightTrackId}
    />
  );
}
