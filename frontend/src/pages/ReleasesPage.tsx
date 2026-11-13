import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useCollectionTint } from "../components/CollectionHeader";
import { DotLoader } from "../components/DotLoader";
import { AlertCircle, Music } from "../components/icons";
import { SkeletonLibraryGrid, SkeletonStatus } from "../components/Skeletons";
import StatePanel from "../components/StatePanel";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { queryClient, queryKeys } from "../queryClient.ts";
import { libraryMiscClient } from "../utils/api/clients/libraryMisc.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { parseCalendarDate } from "../utils/dateTime.ts";
import { AlbumCard } from "./DiscoverCards";
import { useReleaseAlbumAction, type RecentRelease } from "./useReleaseAlbumAction.ts";

const PAGE_SIZE = 24;

const TABS = [
  { when: "released", label: "Released" },
  { when: "upcoming", label: "Upcoming" },
] as const;

const monthLabel = (releaseDate: string) => {
  const date = parseCalendarDate(releaseDate);
  if (!date) return "Date to be announced";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
};

export default function ReleasesPage() {
  useDocumentTitle("Releases");
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const when = searchParams.get("when") === "upcoming" ? "upcoming" : "released";
  const releaseAction = useReleaseAlbumAction();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery({
    queryKey: queryKeys.releaseFeed(user?.id, when),
    queryFn: ({ pageParam, signal }) =>
      parseResponse(
        libraryMiscClient.releases.$get(
          { query: { when, offset: String(pageParam), limit: String(PAGE_SIZE) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((count, page) => count + page.releases.length, 0) : undefined,
    staleTime: 5 * 60 * 1000,
  });
  const releases = query.data?.pages.flatMap((page) => page.releases) ?? [];
  const groups = Map.groupBy(releases, (album) => monthLabel(album.releaseDate));
  const tint = useCollectionTint(resolveAuthenticatedApiAssetUrl(releases[0]?.coverUrl));
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useWebSocketChannel("library", (msg) => {
    if (msg.type === "release_metadata_refreshed") {
      queryClient.invalidateQueries({ queryKey: queryKeys.releases() });
    }
  });

  useEffect(() => {
    if (!hasNextPage || !loadMoreRef.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const renderAlbum = (album: RecentRelease) => (
    <div key={album.id} className="artist-discover-shelf-card">
      <AlbumCard
        album={album}
        canAddAlbum={releaseAction.canAddAlbum}
        isPending={releaseAction.isPending(album)}
        onAlbumAction={releaseAction.onAlbumAction}
      />
    </div>
  );

  const renderBody = () => {
    if (query.isPending) {
      return (
        <SkeletonStatus label="Loading releases">
          <SkeletonLibraryGrid count={12} className="discover-playlist-grid" />
        </SkeletonStatus>
      );
    }
    if (query.error && releases.length === 0) {
      return (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load releases"
          message={query.error.message}
          retrying={query.isFetching}
          onRetry={() => query.refetch()}
        />
      );
    }
    if (releases.length === 0) {
      return (
        <StatePanel
          role="status"
          icon={<Music />}
          title={when === "upcoming" ? "No upcoming releases" : "No recent releases"}
          message="New albums and EPs from your artists show up here."
        />
      );
    }
    return (
      <section className="feed-page__content">
        {[...groups].map(([label, albums]) => (
          <section key={label} className="feed-page__group">
            <h2 className="artist-section-title--discover">{label}</h2>
            <div className="discover-playlist-grid">{albums.map(renderAlbum)}</div>
          </section>
        ))}
        {hasNextPage ? (
          <div ref={loadMoreRef} className="feed-page__load-more" aria-live="polite">
            {isFetchingNextPage ? <DotLoader size="sm" label={null} /> : "Loading more releases…"}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="feed-page" style={tint ? { "--collection-tint": tint } : undefined}>
      <header className="feed-page__header">
        <div className="feed-page__title-row">
          <h1 className="page-title">Releases</h1>
        </div>
        <div className="artist-tabs" role="group" aria-label="Release filters">
          {TABS.map((tab) => (
            <button
              key={tab.when}
              type="button"
              className={`artist-tab${tab.when === when ? " is-active" : ""}`}
              aria-pressed={tab.when === when}
              onClick={() =>
                setSearchParams(tab.when === "upcoming" ? { when: "upcoming" } : {}, {
                  replace: true,
                })
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>
      {renderBody()}
    </div>
  );
}
