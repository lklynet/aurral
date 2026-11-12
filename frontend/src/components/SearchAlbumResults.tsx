import { ReleaseCoverImage } from "./ReleaseCoverImage";
import { Clock, Music } from "./icons";
import SearchLibraryCheck from "./SearchLibraryCheck";
import AddActionButton from "./AddActionButton";
import ReleaseWaitBadge from "./ReleaseWaitBadge";
import { DotLoader } from "./DotLoader";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { getAlbumAddAction } from "../utils/albumAddAction";
import { formatReleaseWait } from "../utils/albumStatus.ts";
import { formatDate, parseCalendarDate } from "../utils/dateTime.ts";
import { getReleaseNavigationTarget, getReleaseTypeLabel } from "../utils/searchNavigation";
import { getSearchAlbumState, type SearchAlbumState } from "../pages/searchPageUtils.ts";
import { OptionalLink } from "./RouteLink";
import Tooltip from "./Tooltip";
import { artworkHoverTint } from "../utils/imageColors.ts";

export type SearchAlbum = {
  id: string;
  title: string;
  status?: string | null;
  artistMbid?: string | null;
  artistName?: string | null;
  coverUrl?: string | null;
  releaseDate?: string | null;
  primaryType?: string | null;
  secondaryTypes?: string[] | null;
  managed?: boolean;
  monitored?: boolean;
  trackFileCount?: number;
};

type AlbumActionProps = {
  canAddAlbum: boolean;
  isPending: boolean;
  onAlbumAction: (album: SearchAlbum) => void;
};

type SearchAlbumResultsProps = Omit<AlbumActionProps, "isPending"> & {
  albums: SearchAlbum[];
  pendingAlbumIds: Record<string, boolean | undefined>;
  viewMode?: "grid" | "list";
};

export const isSearchAlbum = <Item extends { id?: unknown; title?: unknown }>(
  item: Item,
): item is Item & SearchAlbum => typeof item.id === "string" && typeof item.title === "string";

const DOWNLOAD_MISSING_LABEL = "Download missing tracks";

export function useSearchAlbumState(album: SearchAlbum, isPending: boolean) {
  const { isAlbumDownloading } = useActiveDownloads();
  return getSearchAlbumState(album, isPending || isAlbumDownloading(album.id));
}

function getReleaseYear(releaseDate: string | null | undefined) {
  return String(releaseDate || "").match(/^\d{4}/)?.[0] ?? null;
}

export function getAlbumCardMeta(
  album: Pick<SearchAlbum, "artistName" | "releaseDate" | "primaryType">,
) {
  const type = getReleaseTypeLabel(album);
  return [album.artistName, type === "Album" ? getReleaseYear(album.releaseDate) : type]
    .filter(Boolean)
    .join(" · ");
}

function shortReleaseDate(releaseDate: string | null | undefined) {
  const date = parseCalendarDate(releaseDate);
  return date ? formatDate(date, { month: "short", day: "numeric" }) : "Soon";
}

export function SearchAlbumStatus({
  state,
  releaseDate,
}: {
  state: SearchAlbumState;
  releaseDate?: string | null;
}) {
  if (state.kind === "active") {
    return (
      <span className="search-album-status" role="status">
        <DotLoader size="xs" label={null} />
        {state.label}
      </span>
    );
  }
  if (state.kind === "waiting") {
    const label = formatReleaseWait(releaseDate);
    return (
      <Tooltip content={label}>
        <span
          className="search-album-status search-album-status--scheduled"
          role="img"
          aria-label={label}
          tabIndex={0}
        >
          <Clock aria-hidden="true" />
          {shortReleaseDate(releaseDate)}
        </span>
      </Tooltip>
    );
  }
  if (state.kind === "partial") {
    return (
      <Tooltip content="Partially available">
        <span
          className="search-album-status search-album-status--partial"
          role="img"
          aria-label="Partially available"
          tabIndex={0}
        >
          <SearchLibraryCheck size="sm" className="library-check--partial" aria-hidden="true" />
          Partial
        </span>
      </Tooltip>
    );
  }
  return null;
}

export function SearchAlbumAction({
  album,
  state,
  canAddAlbum,
  onAlbumAction,
  showLabel = false,
}: Omit<AlbumActionProps, "isPending"> & {
  album: SearchAlbum;
  state: SearchAlbumState;
  showLabel?: boolean;
}) {
  if (!canAddAlbum || (state.kind !== "available" && state.kind !== "partial")) return null;
  const action =
    state.kind === "partial"
      ? { ...getAlbumAddAction(album), label: DOWNLOAD_MISSING_LABEL }
      : getAlbumAddAction(album);
  if (!showLabel) return <AddActionButton {...action} onAdd={() => onAlbumAction(album)} />;
  const Icon = action.icon;
  return (
    <AddActionButton {...action} className="btn-primary" onAdd={() => onAlbumAction(album)}>
      <Icon aria-hidden="true" />
      {action.label}
    </AddActionButton>
  );
}

function albumLink(album: SearchAlbum) {
  const target = getReleaseNavigationTarget({ ...album, type: "album" });
  if (target) return { to: target.pathname, state: target.state };
  if (album.artistMbid) {
    return {
      to: `/artist/${album.artistMbid}/albums`,
      state: { artistName: album.artistName },
    };
  }
  return null;
}

const artistLink = (album: SearchAlbum) =>
  album.artistMbid
    ? { to: `/artist/${album.artistMbid}`, state: { artistName: album.artistName } }
    : null;

const coverPlaceholder = (
  <div className="artist-release-card__placeholder">
    <Music className="artist-icon-lg" aria-hidden="true" />
  </div>
);

export function SearchAlbumCard({
  album,
  canAddAlbum,
  isPending,
  onAlbumAction,
}: AlbumActionProps & { album: SearchAlbum }) {
  const state = useSearchAlbumState(album, isPending);
  const openAlbum = albumLink(album);
  const meta = getAlbumCardMeta(album);

  return (
    <article className="artist-release-card search-album-card" {...artworkHoverTint}>
      <div className="search-album-results__cover-wrap">
        <OptionalLink
          link={openAlbum}
          className="artist-release-card__cover search-album-results__cover-link"
          aria-label={`Open ${album.title}`}
        >
          <ReleaseCoverImage src={album.coverUrl} alt="" placeholder={coverPlaceholder} />
        </OptionalLink>
        <div className="search-album-card__status">
          <SearchAlbumStatus state={state} releaseDate={album.releaseDate} />
        </div>
        <div className="artist-release-card__action search-album-card__action">
          <SearchAlbumAction
            album={album}
            state={state}
            canAddAlbum={canAddAlbum}
            onAlbumAction={onAlbumAction}
          />
        </div>
      </div>
      <h2 className="search-album-card__title">
        <Tooltip content={album.title}>
          <OptionalLink link={openAlbum} className="search-album-results__title-link">
            {album.title}
          </OptionalLink>
        </Tooltip>
        {state.kind === "complete" ? <SearchLibraryCheck size="sm" /> : null}
      </h2>
      {meta ? (
        <Tooltip content={meta}>
          <p className="artist-release-card__meta artist-truncate">{meta}</p>
        </Tooltip>
      ) : null}
    </article>
  );
}

function SearchAlbumListItem({
  album,
  canAddAlbum,
  isPending,
  onAlbumAction,
}: AlbumActionProps & { album: SearchAlbum }) {
  const state = useSearchAlbumState(album, isPending);
  const openAlbum = albumLink(album);
  const openArtist = artistLink(album);
  const releaseMeta = [
    getReleaseYear(album.releaseDate),
    [album.primaryType, ...(album.secondaryTypes ?? [])].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="artist-release-list-item search-album-results__item">
      <OptionalLink
        link={openAlbum}
        className="search-album-results__cover-link"
        aria-label={`Open ${album.title}`}
      >
        <div className="artist-media-cell artist-list-cover">
          <ReleaseCoverImage
            src={album.coverUrl}
            alt=""
            placeholder={
              <div className="artist-media-placeholder">
                <Music className="artist-icon-md" aria-hidden="true" />
              </div>
            }
          />
        </div>
      </OptionalLink>
      <div className="artist-min-0">
        <h2 className="artist-release-card__title artist-truncate">
          <OptionalLink link={openAlbum} className="search-album-results__title-link">
            {album.title}
          </OptionalLink>
        </h2>
        <div className="artist-release-card__meta artist-truncate">
          {album.artistName ? (
            <OptionalLink link={openArtist} className="artist-link-button">
              {album.artistName}
            </OptionalLink>
          ) : null}
          {album.artistName && releaseMeta ? " · " : null}
          {releaseMeta ? <span>{releaseMeta}</span> : null}
        </div>
      </div>
      <div className="artist-row-actions">
        {state.kind === "complete" ? (
          <SearchLibraryCheck action />
        ) : state.kind === "waiting" ? (
          <ReleaseWaitBadge releaseDate={album.releaseDate} />
        ) : (
          <>
            <SearchAlbumStatus state={state} releaseDate={album.releaseDate} />
            <SearchAlbumAction
              album={album}
              state={state}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </>
        )}
      </div>
    </article>
  );
}

function SearchAlbumResults({
  albums,
  canAddAlbum,
  pendingAlbumIds,
  onAlbumAction,
  viewMode = "grid",
}: SearchAlbumResultsProps) {
  const Item = viewMode === "list" ? SearchAlbumListItem : SearchAlbumCard;
  return (
    <div className={viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"}>
      {albums.map((album) => (
        <Item
          key={album.id}
          album={album}
          canAddAlbum={canAddAlbum}
          isPending={!!pendingAlbumIds[album.id]}
          onAlbumAction={onAlbumAction}
        />
      ))}
    </div>
  );
}

export default SearchAlbumResults;
