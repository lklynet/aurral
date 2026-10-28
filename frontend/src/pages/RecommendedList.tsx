import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ArtistContextMenu } from "../components/ArtistContextMenu";
import ArtistImage from "../components/ArtistImage";
import { ArrowDown, ArrowUp } from "../components/icons";
import RouteLink from "../components/RouteLink";
import { RECOMMENDED_ALL_PATH, recommendedListPath } from "../navigation/recommendedPath.ts";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import {
  firstSeenAt,
  matchesFilter,
  pickReason,
  recommendationContext,
  recommendationReason,
  sortRecommendedRows,
  type RecommendedFilter,
  type RecommendedSort,
} from "./recommendedRails";
import type { useDiscoveryRecommendations, DiscoverData } from "./useDiscoveryRecommendations";

type FeedbackProps = Pick<
  ReturnType<typeof useDiscoveryRecommendations>,
  "artistFeedbackLookup" | "handleDiscoveryFeedback"
>;
type Tab = { label: string; params: Record<string, string>; filter: RecommendedFilter };

const PAGE_SIZE = 60;
const TAB_GENRES = 8;
const DEFAULT_DIRECTION = { rank: "asc", name: "asc", seen: "desc" } as const;

const readFilter = (params: URLSearchParams): RecommendedFilter => {
  const seed = params.get("seed");
  if (seed) return { kind: "seed", value: seed };
  const genre = params.get("genre");
  if (genre) return { kind: "genre", value: genre };
  const show = params.get("show");
  return show === "new" || show === "close" || show === "further"
    ? { kind: show }
    : { kind: "all" };
};

const filterTab = (filter: RecommendedFilter): Tab => {
  if (filter.kind === "seed") {
    return { label: `Because you like ${filter.value}`, params: { seed: filter.value }, filter };
  }
  if (filter.kind === "genre")
    return { label: filter.value, params: { genre: filter.value }, filter };
  const labels = { all: "All", new: "New", close: "Close to home", further: "Further out" };
  return {
    label: labels[filter.kind],
    params: filter.kind === "all" ? {} : { show: filter.kind },
    filter,
  };
};

const tabKey = (tab: Tab) => new URLSearchParams(tab.params).toString();

export function RecommendedList({
  data,
  artistFeedbackLookup,
  handleDiscoveryFeedback,
}: FeedbackProps & { data: DiscoverData }) {
  const [params] = useSearchParams();
  const [now] = useState(Date.now);
  const [sort, setSort] = useState<RecommendedSort>({ key: "rank", direction: "asc" });
  const filterKey = params.toString();
  const [visible, setVisible] = useState({ filterKey, count: PAGE_SIZE });
  const visibleCount = visible.filterKey === filterKey ? visible.count : PAGE_SIZE;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { recommendations, topGenres, basedOn } = data;
  const context = useMemo(
    () => recommendationContext(recommendations, basedOn, now),
    [basedOn, recommendations, now],
  );

  const tabs = useMemo(() => {
    const counted = (filter: RecommendedFilter) => ({
      ...filterTab(filter),
      count: recommendations.filter((artist) => matchesFilter(artist, filter, context)).length,
    });
    const fixed = (["all", "new", "close", "further"] as const).map((kind) => counted({ kind }));
    const genres = topGenres
      .map((value) => counted({ kind: "genre", value }))
      .filter((tab) => tab.count > 0)
      .slice(0, TAB_GENRES)
      .sort((left, right) => right.count - left.count);
    const shown = [...fixed.filter((tab) => tab.count > 0 || tab.filter.kind === "all"), ...genres];
    const active = counted(readFilter(params));
    return shown.some((tab) => tabKey(tab) === tabKey(active)) ? shown : [active, ...shown];
  }, [context, params, recommendations, topGenres]);

  const rows = useMemo(() => {
    const filter = readFilter(params);
    return sortRecommendedRows(
      recommendations
        .map((artist, index) => ({ artist, rank: index + 1 }))
        .filter((row) => matchesFilter(row.artist, filter, context)),
      sort,
    );
  }, [context, params, recommendations, sort]);

  const hasMore = rows.length > visibleCount;
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible({ filterKey, count: visibleCount + PAGE_SIZE });
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [filterKey, hasMore, visibleCount]);

  const sortBy = (key: RecommendedSort["key"]) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: DEFAULT_DIRECTION[key] },
    );
  const SortIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const sortHeader = (key: RecommendedSort["key"], label: string, className?: string) => (
    <th
      scope="col"
      className={className}
      aria-sort={
        sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <button
        type="button"
        className={`recommended-table__sort${sort.key === key ? " is-active" : ""}`}
        onClick={() => sortBy(key)}
      >
        {label}
        {sort.key === key ? <SortIcon aria-hidden="true" /> : null}
      </button>
    </th>
  );

  return (
    <>
      <nav className="search-page__filters recommended-tabs" aria-label="Filter recommendations">
        {tabs.map((tab) => {
          const active = tabKey(tab) === filterKey;
          return (
            <RouteLink
              key={tabKey(tab)}
              to={recommendedListPath(tab.params)}
              className={`search-page__filter${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {tab.label}
              <span className="recommended-tabs__count">{tab.count}</span>
            </RouteLink>
          );
        })}
      </nav>
      {rows.length === 0 ? (
        <div className="search-empty-panel" role="status">
          <p className="search-empty-panel__message">No picks here right now.</p>
          <RouteLink to={RECOMMENDED_ALL_PATH} className="btn btn-secondary btn-sm">
            Show all
          </RouteLink>
        </div>
      ) : (
        <table className="recommended-table">
          <thead>
            <tr>
              {sortHeader("rank", "#", "recommended-table__rank")}
              {sortHeader("name", "Artist")}
              <th scope="col" className="recommended-table__why">
                Because you like
              </th>
              <th scope="col" className="recommended-table__genres">
                Genres
              </th>
              {sortHeader("seen", "First seen", "recommended-table__seen")}
              <th scope="col" className="recommended-table__menu">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visibleCount).map(({ artist, rank }) => {
              const mbid = artist.navigateTo || artist.id;
              const seen = firstSeenAt(artist);
              const reason = pickReason(artist, context.seeds);
              const why = reason.names.join(", ");
              const genres = (artist.matchedTags.length ? artist.matchedTags : artist.tags)
                .slice(0, 2)
                .join(", ");
              const isNew = matchesFilter(artist, { kind: "new" }, context);
              return (
                <tr key={mbid ?? artist.name}>
                  <td className="recommended-table__rank">{rank}</td>
                  <td>
                    <div className="recommended-table__artist">
                      <ArtistImage
                        src={artist.image}
                        mbid={mbid}
                        artistName={artist.name}
                        alt=""
                        className="recommended-table__avatar"
                        showLoading={false}
                        enablePreviewPlayback={Boolean(mbid)}
                      />
                      <div className="recommended-table__name-wrap">
                        {mbid ? (
                          <RouteLink
                            to={`/artist/${mbid}`}
                            state={{ artistName: artist.name, artistImage: artist.image }}
                            className="recommended-table__name"
                          >
                            {artist.name}
                          </RouteLink>
                        ) : (
                          <span className="recommended-table__name">{artist.name}</span>
                        )}
                        <span className="recommended-table__reason">
                          {recommendationReason(artist, context.seeds)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="recommended-table__why">
                    {why && reason.kind === "via" ? `via ${why}` : why}
                  </td>
                  <td className="recommended-table__genres">{genres}</td>
                  <td className={`recommended-table__seen${isNew ? " is-new" : ""}`}>
                    {seen
                      ? formatRelativeTime(new Date(seen), { now: new Date(now), unit: "day" })
                      : null}
                  </td>
                  <td className="recommended-table__menu">
                    <ArtistContextMenu
                      artist={artist}
                      onFeedback={handleDiscoveryFeedback}
                      feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {hasMore ? <div ref={sentinelRef} className="recommended-table__sentinel" /> : null}
    </>
  );
}
