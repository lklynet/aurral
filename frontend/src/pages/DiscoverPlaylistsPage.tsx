import { useState } from "react";
import ArtworkImage from "../components/ArtworkImage";
import { useCollectionTint } from "../components/CollectionHeader";
import { AlertCircle } from "../components/icons";
import RouteLink from "../components/RouteLink";
import { SkeletonShape, SkeletonStatus } from "../components/Skeletons";
import StatePanel from "../components/StatePanel";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { useArtworkWash } from "../utils/imageColors.ts";
import { DiscoverPlaylistSection, type BrowseShelfPlaylist } from "./DiscoverPlaylistSection";
import { playlistCategoryPath, usePlaylistCategories } from "./usePlaylistShelf";

const FEATURED_TILES = [
  ["mood", 0, 4],
  ["decade", 0, 2],
  ["genre", 0, 2],
  ["mood", 4, 5],
  ["genre", 2, 3],
] as const;

function CategoryTile({
  id,
  name,
  playlists,
}: {
  id: string;
  name: string;
  playlists: BrowseShelfPlaylist[];
}) {
  const cover = resolveAuthenticatedApiAssetUrl(playlists[0]?.artworkUrl) || null;
  const wash = useArtworkWash(cover);
  return (
    <RouteLink
      to={playlistCategoryPath(id)}
      className="playlist-category-tile"
      style={wash ? { "--tile-wash": `light-dark(${wash.light}, ${wash.dark})` } : undefined}
    >
      <span className="playlist-category-tile__name">{name}</span>
      {cover && (
        <ArtworkImage src={cover} alt="" className="playlist-category-tile__cover" loading="lazy" />
      )}
    </RouteLink>
  );
}

export default function DiscoverPlaylistsPage() {
  useDocumentTitle("Playlists");
  const { browse, madeForYou, shelf } = usePlaylistCategories();
  const [showAll, setShowAll] = useState(false);
  const featured = FEATURED_TILES.flatMap(([group, start, end]) =>
    browse.filter((category) => category.group === group).slice(start, end),
  );
  const tiles = showAll ? browse : featured;
  const moods = browse.filter((category) => category.group === "mood").slice(0, 2);
  const throwbacks = browse
    .filter((category) => category.group === "decade")
    .flatMap((category) => category.playlists.slice(0, 1));
  const loading = madeForYou.isPending || shelf.isPending;
  const lead = madeForYou.data?.discovery[0] ?? shelf.data?.forYou[0] ?? browse[0]?.playlists[0];
  const tint = useCollectionTint(resolveAuthenticatedApiAssetUrl(lead?.artworkUrl));

  return (
    <div
      className="discover-playlists-page"
      style={tint ? { "--collection-tint": tint } : undefined}
    >
      <h1 className="page-title discover-playlists-page__title">Playlists</h1>
      <DiscoverPlaylistSection title="Made for you" playlists={madeForYou.data?.discovery} />
      <DiscoverPlaylistSection
        title="Your genres"
        playlists={shelf.data?.forYou}
        viewAllTo={playlistCategoryPath("for-you")}
      />
      {loading && browse.length === 0 ? (
        <SkeletonStatus
          label="Loading playlists"
          className="playlist-category-grid playlist-category-grid--featured"
        >
          {Array.from({ length: 10 }, (_, index) => (
            <SkeletonShape key={index} className="playlist-category-tile" />
          ))}
        </SkeletonStatus>
      ) : (
        browse.length > 0 && (
          <section className="playlist-browse" aria-labelledby="playlist-browse-title">
            <div className="artist-discover-rail__header">
              <h2 id="playlist-browse-title" className="artist-section-title--discover">
                Browse
              </h2>
              {browse.length > featured.length && (
                <button
                  type="button"
                  className="section-show-all"
                  aria-expanded={showAll}
                  onClick={() => setShowAll(!showAll)}
                >
                  {showAll ? "Fewer categories" : "All categories"}
                </button>
              )}
            </div>
            <div
              className={`playlist-category-grid${showAll ? "" : " playlist-category-grid--featured"}`}
            >
              {tiles.map((category) => (
                <CategoryTile key={category.id} {...category} />
              ))}
            </div>
          </section>
        )
      )}
      {shelf.error && (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load playlists"
          message="Deezer didn’t respond. Try again in a moment."
          retrying={shelf.isFetching}
          onRetry={() => shelf.refetch()}
        />
      )}
      {moods.map((category) => (
        <DiscoverPlaylistSection
          key={category.id}
          title={category.name}
          playlists={category.playlists}
          viewAllTo={playlistCategoryPath(category.id)}
        />
      ))}
      <DiscoverPlaylistSection title="Throwbacks" playlists={throwbacks} />
    </div>
  );
}
