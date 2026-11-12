import { Music, Pause, Play } from "./icons";
import ArtistImage, { imageCandidates } from "./ArtistImage";
import { DotLoader } from "./DotLoader";
import { ReleaseCoverImage } from "./ReleaseCoverImage";
import SearchLibraryCheck from "./SearchLibraryCheck";
import RouteLink from "./RouteLink";
import {
  SearchAlbumAction,
  SearchAlbumStatus,
  getAlbumCardMeta,
  isSearchAlbum,
  useSearchAlbumState,
  type SearchAlbum,
} from "./SearchAlbumResults";
import { SongDownload, useSongPlayback } from "./SearchSongList";
import { useToast } from "../contexts/ToastContext";
import { isAlbumCompleteInLibrary } from "../utils/albumAddAction";
import { useArtistPreviewPlayback } from "../hooks/useArtistPreviewPlayback";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  getReleaseTypeLabel,
  getSearchResultLink,
  type SearchItem,
} from "../utils/searchNavigation";

type AlbumProps = {
  canAddAlbum: boolean;
  pendingAlbumIds: Record<string, boolean | undefined>;
  onAlbumAction: (album: SearchAlbum) => void;
};

function PlayButton({
  label,
  playing,
  loading = false,
  onPlay,
}: {
  label: string;
  playing: boolean;
  loading?: boolean;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      className="native-library-page-play"
      aria-label={label}
      aria-busy={loading || undefined}
      onClick={onPlay}
    >
      {loading ? (
        <DotLoader size="xs" label={null} />
      ) : playing ? (
        <Pause aria-hidden="true" />
      ) : (
        <Play aria-hidden="true" />
      )}
      {playing ? "Pause" : "Play"}
    </button>
  );
}

function ArtistPlay({ item }: { item: SearchItem }) {
  const { showInfo } = useToast();
  const name = item.name || "";
  const { canPlayArtistPreview, isArtistPreviewActive, isLoadingPreview, playArtistPreview } =
    useArtistPreviewPlayback({
      mbid: getArtistRecordId(item),
      artistName: name,
      isInLibrary: Boolean(item.inLibrary),
    });
  if (!canPlayArtistPreview) return null;
  return (
    <PlayButton
      label={
        isArtistPreviewActive
          ? `Pause ${name}`
          : `Play ${name}${item.inLibrary ? "" : " top tracks"}`
      }
      playing={isArtistPreviewActive}
      loading={isLoadingPreview}
      onPlay={async () => {
        if (!(await playArtistPreview())) showInfo(`No preview found for ${name}`);
      }}
    />
  );
}

function AlbumAction({
  album,
  canAddAlbum,
  pendingAlbumIds,
  onAlbumAction,
}: AlbumProps & { album: SearchAlbum }) {
  const state = useSearchAlbumState(album, !!pendingAlbumIds[album.id]);
  return (
    <>
      <SearchAlbumStatus state={state} releaseDate={album.releaseDate} />
      <SearchAlbumAction
        album={album}
        state={state}
        canAddAlbum={canAddAlbum}
        onAlbumAction={onAlbumAction}
        showLabel
      />
    </>
  );
}

function SongAction({ song, canDownload }: { song: SearchItem; canDownload: boolean }) {
  const playback = useSongPlayback(song);
  const title = song.title || "";
  if (playback) {
    return (
      <PlayButton
        label={`${playback.playing ? "Pause" : "Play"} ${title}`}
        playing={playback.playing}
        onPlay={playback.toggle}
      />
    );
  }
  return canDownload && !song.inLibrary ? <SongDownload song={song} showLabel /> : null;
}

function artistImageProps(item: SearchItem) {
  return {
    src: item.image || item.imageUrl,
    mbid: getArtistRecordId(item),
    isInLibrary: Boolean(item.inLibrary),
    thumbnail: false,
  };
}

export function topResultArtwork(item: SearchItem) {
  return item.type === "artist" ? imageCandidates(artistImageProps(item))[0]?.src : item.coverUrl;
}

function topMeta(item: SearchItem) {
  if (item.type === "artist") return "Artist";
  if (item.type === "album") return `${getReleaseTypeLabel(item)} · ${getAlbumCardMeta(item)}`;
  return ["Song", item.artistName].filter(Boolean).join(" · ");
}

export default function SearchTopResult({
  item,
  query,
  ...albumProps
}: AlbumProps & {
  item: SearchItem;
  query: string;
}) {
  const name = (item.type === "artist" ? item.name : item.title) || "";
  const link = getSearchResultLink(item, { query });
  const owned =
    item.type === "album" ? isAlbumCompleteInLibrary({ status: item.status }) : item.inLibrary;
  const action =
    item.type === "artist" ? (
      <ArtistPlay item={item} />
    ) : item.type === "album" && isSearchAlbum(item) ? (
      <AlbumAction album={item} {...albumProps} />
    ) : (
      <SongAction song={item} canDownload={albumProps.canAddAlbum} />
    );

  return (
    <article className={`search-top${item.type === "artist" ? " search-top--artist" : ""}`}>
      <span className="search-top__art" aria-hidden="true">
        {item.type === "artist" ? (
          <ArtistImage {...artistImageProps(item)} artistName={item.name} alt="" sizes="13rem" />
        ) : (
          <ReleaseCoverImage
            src={item.coverUrl}
            alt=""
            sizes="13rem"
            placeholder={
              <span className="search-top__placeholder">
                <Music className="artist-icon-lg" />
              </span>
            }
          />
        )}
      </span>
      <div className="search-top__body">
        <h3 className="search-top__name">
          {link ? (
            <RouteLink to={link.to} state={link.state} className="search-top__link card-link">
              {name}
            </RouteLink>
          ) : (
            name
          )}
          {owned ? <SearchLibraryCheck /> : null}
        </h3>
        <p className="search-top__meta">{topMeta(item)}</p>
        <div className="search-top__action">{action}</div>
      </div>
    </article>
  );
}
