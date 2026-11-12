import type { ComponentProps } from "react";
import { DiscoverRail } from "../components/DiscoverRail";
import PlaylistCard from "../components/PlaylistCard";
import RouteLink from "../components/RouteLink";
import SearchAlbumResults, {
  SearchAlbumCard,
  isSearchAlbum,
  type SearchAlbum,
} from "../components/SearchAlbumResults";
import { SearchArtistCard } from "../components/SearchArtistResults";
import SearchSongList from "../components/SearchSongList";
import SearchTopResult from "../components/SearchTopResult";
import { usePlaylistArtwork } from "../hooks/usePlaylistArtwork.ts";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  getPlaylistResultDetail,
  getSearchResultKey,
  getSearchResultLink,
  isSameSearchResult,
  type SearchItem,
  type buildSearchSections,
} from "../utils/searchNavigation";
import type { UnifiedFilter } from "./searchPageUtils";

type Sections = ReturnType<typeof buildSearchSections<SearchItem>>;
type ArtistFeedback = Pick<
  ComponentProps<typeof SearchArtistCard>,
  "onArtistFeedback" | "artistFeedbackLookup"
>;

type SearchUnifiedResultsProps = ArtistFeedback & {
  sections: Sections;
  filter: UnifiedFilter;
  query: string;
  filterPath: (filter: UnifiedFilter) => string;
  canAddAlbum: boolean;
  pendingAlbumIds: Record<string, boolean | undefined>;
  onAlbumAction: (album: SearchAlbum) => void;
  renderSongMenu: ComponentProps<typeof SearchSongList>["renderMenu"];
};

const HERO_SONGS = 4;
const RAIL_SHOW_ALL_AT = 7;

export function hasUnifiedResults(sections: Sections, filter: UnifiedFilter) {
  if (filter === "all") {
    return Boolean(
      sections.top ||
      sections.songs.length ||
      sections.albums.length ||
      sections.singles.length ||
      sections.artists.length ||
      sections.playlists.length,
    );
  }
  const items = {
    tracks: sections.songs,
    albums: sections.albums,
    singles: sections.singles,
    artists: sections.artists,
    playlists: sections.playlists,
  }[filter];
  return items.length > 0;
}

function SectionHeader({
  id,
  title,
  showAllTo,
}: {
  id: string;
  title: string;
  showAllTo?: string;
}) {
  return (
    <div className="artist-discover-rail__header">
      <h2 id={id} className="artist-section-title--discover">
        {title}
      </h2>
      {showAllTo ? (
        <RouteLink to={showAllTo} className="section-show-all">
          Show all
        </RouteLink>
      ) : null}
    </div>
  );
}

function PlaylistCards({ playlists }: { playlists: SearchItem[] }) {
  const { artworkUrlFor } = usePlaylistArtwork();
  return playlists.map((playlist) => {
    const link = getSearchResultLink(playlist);
    if (!link) return null;
    return (
      <PlaylistCard
        key={playlist.key ?? playlist.id}
        to={link.to}
        state={link.state}
        name={playlist.name || ""}
        artworkUrl={playlist.coverUrl || artworkUrlFor(String(playlist.id))}
        meta={getPlaylistResultDetail(playlist) || (playlist.sourceFlowId ? "Flow" : null)}
      />
    );
  });
}

export default function SearchUnifiedResults({
  sections,
  filter,
  query,
  filterPath,
  canAddAlbum,
  pendingAlbumIds,
  onAlbumAction,
  renderSongMenu,
  onArtistFeedback,
  artistFeedbackLookup,
}: SearchUnifiedResultsProps) {
  const albumProps = { canAddAlbum, pendingAlbumIds, onAlbumAction };
  const songListProps = { query, canDownload: canAddAlbum, renderMenu: renderSongMenu };
  const artistCard = (artist: SearchItem, index: number) => (
    <SearchArtistCard
      key={getArtistRecordId(artist) || `artist-${index}`}
      artist={artist}
      isInLibrary={Boolean(artist.inLibrary)}
      onArtistFeedback={onArtistFeedback}
      artistFeedbackLookup={artistFeedbackLookup}
    />
  );

  if (filter === "tracks") {
    return <SearchSongList songs={sections.songs} label="Songs" {...songListProps} />;
  }
  if (filter === "albums" || filter === "singles") {
    return (
      <SearchAlbumResults
        albums={sections[filter].filter(isSearchAlbum)}
        {...albumProps}
        viewMode="grid"
      />
    );
  }
  if (filter === "artists") {
    return (
      <div className="artist-release-grid search-artist-grid--round">
        {sections.artists.map(artistCard)}
      </div>
    );
  }
  if (filter === "playlists") {
    return (
      <div className="search-playlist-grid">
        <PlaylistCards playlists={sections.playlists} />
      </div>
    );
  }

  const { top } = sections;
  const notTop = (items: SearchItem[]) =>
    top ? items.filter((item) => !isSameSearchResult(top, item)) : items;
  const songs = notTop(sections.songs);
  const heroSongs = songs.slice(0, HERO_SONGS);
  const rails = [
    { filter: "albums", title: "Albums", items: notTop(sections.albums).filter(isSearchAlbum) },
    {
      filter: "singles",
      title: "Singles and EPs",
      items: notTop(sections.singles).filter(isSearchAlbum),
    },
  ] as const;
  const artists = notTop(sections.artists);
  const showAllTo = (items: unknown[], tab: UnifiedFilter) =>
    items.length >= RAIL_SHOW_ALL_AT ? filterPath(tab) : undefined;

  return (
    <>
      {top || heroSongs.length ? (
        <div className={`search-hero${top && heroSongs.length ? "" : " search-hero--single"}`}>
          {top ? (
            <section className="search-hero__top" aria-labelledby="search-top-heading">
              <SectionHeader id="search-top-heading" title="Top result" />
              <SearchTopResult item={top} query={query} {...albumProps} />
            </section>
          ) : null}
          {heroSongs.length ? (
            <section aria-labelledby="search-songs-heading">
              <SectionHeader
                id="search-songs-heading"
                title="Songs"
                showAllTo={songs.length > HERO_SONGS ? filterPath("tracks") : undefined}
              />
              <SearchSongList songs={heroSongs} label="Songs" {...songListProps} />
            </section>
          ) : null}
        </div>
      ) : null}

      {rails.map((rail) =>
        rail.items.length ? (
          <DiscoverRail
            key={rail.filter}
            title={rail.title}
            viewAllTo={showAllTo(rail.items, rail.filter)}
          >
            {rail.items.map((album) => (
              <div key={getSearchResultKey(album)} className="artist-discover-shelf-card">
                <SearchAlbumCard
                  album={album}
                  isPending={!!pendingAlbumIds[album.id]}
                  canAddAlbum={canAddAlbum}
                  onAlbumAction={onAlbumAction}
                />
              </div>
            ))}
          </DiscoverRail>
        ) : null,
      )}

      {artists.length ? (
        <DiscoverRail title="Artists" viewAllTo={showAllTo(artists, "artists")}>
          {artists.map((artist, index) => (
            <div key={getSearchResultKey(artist, index)} className="artist-discover-shelf-card">
              {artistCard(artist, index)}
            </div>
          ))}
        </DiscoverRail>
      ) : null}

      {sections.playlists.length ? (
        <DiscoverRail title="Playlists" viewAllTo={showAllTo(sections.playlists, "playlists")}>
          <PlaylistCards playlists={sections.playlists} />
        </DiscoverRail>
      ) : null}
    </>
  );
}
