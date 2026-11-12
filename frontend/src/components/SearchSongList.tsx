import type { ReactNode } from "react";
import { Download, Music, Pause, Play } from "./icons";
import AddActionButton from "./AddActionButton";
import { DotLoader } from "./DotLoader";
import { ReleaseCoverImage } from "./ReleaseCoverImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import RouteLink from "./RouteLink";
import Tooltip from "./Tooltip";
import type { QueueMenuItem } from "./TrackPlaylistMenu";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { useQueueTrackActions } from "../hooks/useQueueTrackActions";
import { useAddTrackToLibrary } from "../hooks/useAddTrackToLibrary";
import { normalizeStreamQueueTrack } from "../utils/audioQueue";
import {
  getSearchResultKey,
  getSearchResultLink,
  type SearchItem,
} from "../utils/searchNavigation";
import { trackDownloadActionLabel } from "../utils/trackDownloadLabel.ts";
import { formatDuration } from "../pages/library/libraryShared.tsx";
import { searchTrackPayload } from "../pages/searchPageUtils.ts";

type SearchSongListProps = {
  songs: SearchItem[];
  label: string;
  query: string;
  canDownload: boolean;
  renderMenu: (song: SearchItem, queueItems: QueueMenuItem[]) => ReactNode;
};

const coverPlaceholder = (
  <span className="search-song__placeholder" aria-hidden="true">
    <Music className="artist-icon-sm" />
  </span>
);

function songQueueTrack(song: SearchItem) {
  const streamPath = song.streamPath;
  if (!streamPath) return null;
  return normalizeStreamQueueTrack({
    id: song.id,
    title: song.title,
    artistName: song.artistName,
    albumName: song.albumTitle,
    artistMbid: song.artistMbid,
    albumMbid: song.albumMbid,
    trackMbid: song.trackMbid,
    durationMs: song.durationMs,
    libraryTrackId: song.id,
    libraryAlbumId: song.libraryAlbumId,
    streamPath,
    artworkUrl: song.coverUrl,
  });
}

export function useSongPlayback(song: SearchItem) {
  const { currentTrack, isPlaying, playTrack, togglePlayPause } = useAudioQueue();
  const track = songQueueTrack(song);
  if (!track) return null;
  const current = currentTrack?.id === String(song.id);
  return {
    track,
    playing: current && isPlaying,
    toggle: () => (current ? togglePlayPause() : playTrack(track)),
  };
}

type SongPlayback = ReturnType<typeof useSongPlayback>;

function SongCover({ song, playback }: { song: SearchItem; playback: SongPlayback }) {
  const cover = (
    <ReleaseCoverImage src={song.coverUrl} alt="" sizes="3rem" placeholder={coverPlaceholder} />
  );
  if (!playback) return <span className="search-song__cover">{cover}</span>;
  const label = `${playback.playing ? "Pause" : "Play"} ${song.title}`;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`search-song__cover search-song__play${playback.playing ? " is-playing" : ""}`}
        aria-label={label}
        onClick={playback.toggle}
      >
        {cover}
        <span className="search-song__play-icon" aria-hidden="true">
          {playback.playing ? <Pause /> : <Play />}
        </span>
      </button>
    </Tooltip>
  );
}

export function SongDownload({
  song,
  showLabel = false,
}: {
  song: SearchItem;
  showLabel?: boolean;
}) {
  const { savingKeys, addTrackToLibrary } = useAddTrackToLibrary();
  const { isTrackDownloading } = useActiveDownloads();
  const savingKey = String(song.key ?? song.id);
  const downloading = isTrackDownloading(song);
  const busy = downloading || savingKeys.has(savingKey);
  const label = trackDownloadActionLabel(
    downloading ? "downloading" : savingKeys.has(savingKey) ? "submitting" : null,
  );
  const add = () => void addTrackToLibrary(searchTrackPayload(song), savingKey);
  if (showLabel) {
    return (
      <AddActionButton label={label} className="btn-primary" disabled={busy} onAdd={add}>
        {busy ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
        {busy ? label : "Download"}
      </AddActionButton>
    );
  }
  return (
    <AddActionButton
      icon={Download}
      label={label}
      aria-label={`${label}: ${song.title}`}
      busy={busy}
      disabled={busy}
      onAdd={add}
    />
  );
}

function SongRow({
  song,
  query,
  canDownload,
  renderMenu,
}: Omit<SearchSongListProps, "songs" | "label"> & { song: SearchItem }) {
  const playback = useSongPlayback(song);
  const getQueueItems = useQueueTrackActions();
  const link = getSearchResultLink(song, { query });
  const title = song.title || "";
  const album = song.albumTitle || "";
  const queueItems = playback
    ? [
        {
          id: "play",
          label: playback.playing ? "Pause" : "Play",
          icon: playback.playing ? Pause : Play,
          disabled: false,
          onSelect: playback.toggle,
        },
        ...getQueueItems(playback.track),
      ]
    : [];
  return (
    <div className="search-song" role="listitem">
      <SongCover song={song} playback={playback} />
      <div className="search-song__copy">
        <span className="search-song__title">
          <Tooltip content={title}>
            {link ? (
              <RouteLink to={link.to} state={link.state} className="search-song__link">
                {title}
              </RouteLink>
            ) : (
              <span className="search-song__link">{title}</span>
            )}
          </Tooltip>
          {song.inLibrary ? <SearchLibraryCheck size="sm" /> : null}
        </span>
        <span className="search-song__artist">
          {song.artistName}
          {album ? <span className="search-song__artist-album"> · {album}</span> : null}
        </span>
      </div>
      <span className="search-song__album">{album}</span>
      <span className="search-song__time">{formatDuration(song.durationMs)}</span>
      <span className="search-song__actions">
        {canDownload && !song.inLibrary ? <SongDownload song={song} /> : null}
        {renderMenu(song, queueItems)}
      </span>
    </div>
  );
}

export default function SearchSongList({ songs, label, ...rowProps }: SearchSongListProps) {
  return (
    <div className="search-songs" role="list" aria-label={label}>
      {songs.map((song, index) => (
        <SongRow key={getSearchResultKey(song, index)} song={song} {...rowProps} />
      ))}
    </div>
  );
}
