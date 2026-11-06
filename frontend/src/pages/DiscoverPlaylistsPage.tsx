import { useSearchParams } from "react-router";
import { SkeletonRail, SkeletonStatus } from "../components/Skeletons";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { useMadeForYou, usePlaylistShelf } from "./usePlaylistShelf";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "made-for-you", label: "Made for you" },
  { id: "moods", label: "Moods" },
  { id: "decades", label: "Decades" },
  { id: "genres", label: "Genres" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

const GROUPS = { moods: "mood", decades: "decade", genres: "genre" } as const;

const isFilter = (value: string | null): value is Filter =>
  FILTERS.some((filter) => filter.id === value);

export default function DiscoverPlaylistsPage() {
  useDocumentTitle("Playlists");
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("filter");
  const filter: Filter = isFilter(requested) ? requested : "all";
  const madeForYou = useMadeForYou();
  const shelf = usePlaylistShelf();

  const selectFilter = (next: Filter) =>
    setSearchParams(next === "all" ? {} : { filter: next }, { replace: true });

  const renderLoading = (count: number) => (
    <SkeletonStatus label="Loading playlists">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRail key={index} kind="playlist" />
      ))}
    </SkeletonStatus>
  );

  const renderMadeForYou = () => {
    if (madeForYou.isPending) return renderLoading(1);
    const { discovery = [], mixes = [] } = madeForYou.data ?? {};
    return (
      <>
        <DiscoverPlaylistSection title="Made for you" playlists={discovery} />
        <DiscoverPlaylistSection title="Your mixes" playlists={mixes} />
      </>
    );
  };

  const renderShelf = () => {
    if (shelf.isPending) return renderLoading(3);
    if (shelf.error) {
      return (
        <div className="search-empty-panel" role="alert">
          <h2 className="search-empty-panel__title">Playlists didn&rsquo;t load</h2>
          <p className="search-empty-panel__message">
            Deezer didn&rsquo;t respond. Try again in a moment.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={shelf.isFetching}
            onClick={() => shelf.refetch()}
          >
            Try again
          </button>
        </div>
      );
    }
    const categories = shelf.data?.categories ?? [];
    const groups =
      filter === "all"
        ? (["mood", "decade", "genre"] as const)
        : filter === "made-for-you"
          ? []
          : [GROUPS[filter]];
    return (
      <>
        {filter === "all" && (
          <DiscoverPlaylistSection title="For you" playlists={shelf.data?.forYou ?? []} />
        )}
        {groups.flatMap((group) =>
          categories
            .filter((category) => category.group === group)
            .map((category) => (
              <DiscoverPlaylistSection
                key={category.id}
                title={category.name}
                playlists={category.playlists}
              />
            )),
        )}
      </>
    );
  };

  return (
    <div className="discover-playlists-page">
      <header className="discover-playlists-page__header">
        <div className="discover-playlists-page__title-row">
          <h1 className="page-title">Playlists</h1>
        </div>
        <div className="artist-segmented" role="tablist" aria-label="Playlist filters">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
              className={`artist-segmented-button${filter === entry.id ? " is-active" : ""}`}
              onClick={() => selectFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      {(filter === "all" || filter === "made-for-you") && renderMadeForYou()}
      {filter !== "made-for-you" && renderShelf()}
    </div>
  );
}
