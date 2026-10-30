import { useEffect, useMemo, useCallback, type ComponentProps } from "react";
import {
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
} from "../utils/api/endpoints/library.ts";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { usersClient } from "../utils/api/clients/users.ts";

import { AlertCircle, LayoutTemplate } from "../components/icons";
import { DotLoader } from "../components/DotLoader";
import {
  SkeletonDiscoverCard,
  SkeletonFeedTile,
  SkeletonRail,
  SkeletonShape,
  SkeletonStatus,
} from "../components/Skeletons";
import { resolveLibraryArtistPath } from "../navigation/resolveLinks.ts";
import DiscoveryStatusPill from "../components/DiscoveryStatusPill";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import NearbyLocationControl from "../components/NearbyLocationControl";
import { NewsFeedTile, ShowFeedTile } from "../components/DiscoverFeed";
import { useToast } from "../contexts/ToastContext";
import { DiscoverRail } from "../components/DiscoverRail";
import { DiscoverLayoutModal } from "./DiscoverLayoutModal";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { useEditorialShelf } from "./useEditorialShelf";
import { TrendingArtistsRail } from "./TrendingArtistsRail";
import { trendingChartsQueryOptions } from "../queryOptions.ts";
import { AlbumCard, ArtistCard, ViewAllCard, type DiscoverCardArtist } from "./DiscoverCards";
import { useDiscoverLayoutState } from "./useDiscoverLayoutState";
import {
  DEFAULT_DISCOVER_SECTIONS,
  DISCOVER_PREVIEW_ITEM_LIMIT,
  artistMatchesGenre,
  shuffleWithSeed,
  normalizeDiscoverLayout,
  readStoredDiscoverLayout,
  writeStoredDiscoverLayout,
  type DiscoverSection,
} from "./discoverUtils";
import { useDiscoverData } from "./useDiscoverData";
import type { DiscoverFeedStyle } from "../../../lib/discoverLayout.ts";
import { useLibraryNews } from "../hooks/useLibraryNews";
import { formatDate, formatRelativeTime } from "../utils/dateTime.ts";
import TooltipButton from "../components/TooltipButton";
import RouteLink from "../components/RouteLink";
import { SettingsLink } from "./Settings/settingsRoute";
import { useArtistTint } from "../components/CollectionHeader";
import { lastRecommendedPath, recommendedListPath } from "../navigation/recommendedPath";
import { recommendationReason, seedNameSet } from "./recommendedRails";
const getArtistId = (artist: DiscoverCardArtist) => getArtistRecordId(artist);

const loadServerLayout = () => parseResponse(usersClient.me["discover-layout"].$get());
const saveServerLayout = (layout: DiscoverSection[]) =>
  parseResponse(usersClient.me["discover-layout"].$patch({ json: { layout } }));

const TOP_TAG_LIMIT = 12;
const FEED_LIST_LIMIT = 6;

const feedRailClass = (feedStyle: DiscoverFeedStyle) =>
  `discover-feed-rail discover-feed-rail--${feedStyle}`;

const feedItemLimit = (feedStyle: DiscoverFeedStyle) =>
  feedStyle === "list" ? FEED_LIST_LIMIT : DISCOVER_PREVIEW_ITEM_LIMIT;

const feedSkeletons = (feedStyle: DiscoverFeedStyle, round = false) =>
  Array.from({ length: FEED_LIST_LIMIT }, (_, index) => (
    <SkeletonFeedTile key={index} feedStyle={feedStyle} round={round} />
  ));

const SECTION_CARD_KINDS = new Map<
  string,
  NonNullable<ComponentProps<typeof SkeletonRail>["kind"]>
>([
  ["playlists", "playlist"],
  ["recentReleases", "album"],
]);

function DiscoverPage() {
  useDocumentTitle("Discover");
  const { user: authUser, bootstrap, hasPermission } = useAuth();
  const canManageServer = hasPermission("accessSettings");
  const { showSuccess, showError } = useToast();
  const newsConfigured = bootstrap?.newsConfigured === true;
  const {
    articles: newsArticles,
    loading: newsLoading,
    error: newsError,
    refresh: newsRefresh,
    disableFeed: disableNewsFeed,
  } = useLibraryNews({ enabled: newsConfigured, limit: 12, mode: "top", userId: authUser?.id });

  const {
    data,
    recentlyAdded,
    recentlyAddedPending,
    recentReleases,
    recentReleasesPending,
    pendingRecentReleaseIds,
    error,
    libraryLookup,
    setLibraryLookup,
    artistFeedbackLookup,
    nearbyShowsData,
    ticketmasterConfigured,
    nearbyShowsLoading,
    nearbyShowsError,
    nearbyLocationMode,
    appliedNearbyCountry,
    setNearbyLocationMode,
    appliedNearbyZip,
    setAppliedNearbyZip,
    canAddAlbum,
    getLibraryArtistImage,
    getRecentReleaseKey,
    libraryDestination,
    handleRecentReleaseAlbumAction,
    handleDiscoveryFeedback,
    discoveryStatus,
  } = useDiscoverData();

  const {
    discoverSections,
    draftSections,
    setDraftSections,
    showDiscoverModal,
    setShowDiscoverModal,
    isSavingDiscoverLayout,
    saveDiscoverLayout,
  } = useDiscoverLayoutState({
    defaultSections: DEFAULT_DISCOVER_SECTIONS,
    userId: authUser?.id,
    normalizeLayout: normalizeDiscoverLayout,
    readStoredLayout: readStoredDiscoverLayout,
    writeStoredLayout: writeStoredDiscoverLayout,
    loadServerLayout,
    saveServerLayout,
    showSuccess,
    showError,
  });

  const genreSections = useMemo(() => {
    if (!data?.topGenres || !data?.recommendations) return [];

    const sections = [];
    const usedArtistIds = new Set(
      (data.recommendations || [])
        .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
        .map((artist) => getArtistId(artist))
        .filter(Boolean),
    );

    const genres = shuffleWithSeed(data.topGenres, data.discoveryRunId || data.lastUpdated);
    const candidatePool = (data.recommendations || []).slice(DISCOVER_PREVIEW_ITEM_LIMIT);

    for (const genre of genres) {
      if (sections.length >= 12) break;

      const genreArtists = candidatePool.filter((artist) => {
        const artistId = getArtistId(artist);
        if (artistId && usedArtistIds.has(artistId)) return false;
        return artistMatchesGenre(artist, genre);
      });

      if (genreArtists.length >= 4) {
        const selectedArtists = genreArtists
          .sort((left, right) => {
            const leftScore = Number(left.scoreTotal || left.score || 0);
            const rightScore = Number(right.scoreTotal || right.score || 0);
            if (rightScore !== leftScore) return rightScore - leftScore;
            return String(left.name || "").localeCompare(String(right.name || ""));
          })
          .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT);

        selectedArtists.forEach((artist) => {
          const artistId = getArtistId(artist);
          if (artistId) usedArtistIds.add(artistId);
        });

        sections.push({
          genre,
          artists: selectedArtists,
        });
      }
    }

    return sections;
  }, [data]);

  const hasData =
    data &&
    ((data.recommendations && data.recommendations.length > 0) ||
      (data.globalTop && data.globalTop.length > 0) ||
      (data.topGenres && data.topGenres.length > 0));
  const isUpdating = Boolean(discoveryStatus?.isUpdating);
  const updateProgressMessage = discoveryStatus?.updateProgressMessage || null;
  const isActuallyUpdating = isUpdating && !hasData;

  const { recommendations = [], topGenres = [], basedOn = [] } = data || {};
  const seeds = useMemo(() => seedNameSet(basedOn), [basedOn]);
  const { data: editorialShelf, isPending: editorialShelfPending } = useEditorialShelf();
  const { data: trending } = useQuery(trendingChartsQueryOptions(authUser?.id));
  const trendingArtists = trending?.artists;

  const nearbyShows: NonNullable<typeof nearbyShowsData>["shows"][number][] =
    nearbyShowsData?.shows || [];
  const nearbyLocationLabel =
    nearbyShowsData?.location?.label || nearbyShowsData?.location?.postalCode || "your area";
  const featuredPlaylists = useMemo(() => {
    const forYou = editorialShelf?.forYou || [];
    return forYou.length > 0 ? forYou : editorialShelf?.genres?.[0]?.playlists || [];
  }, [editorialShelf]);

  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      playlists: featuredPlaylists.length > 0,
      recentReleases: recentReleases.length > 0,
      news: newsConfigured,
      recommended: true,
      recommendedShows: ticketmasterConfigured,
      globalTop: Boolean(trendingArtists?.length),
      genreSections: genreSections.length > 0,
    }),
    [
      recentlyAdded,
      featuredPlaylists,
      recentReleases,
      newsConfigured,
      trendingArtists,
      genreSections,
      ticketmasterConfigured,
    ],
  );

  const getArtistLibraryLink = useCallback((artist: DiscoverCardArtist) => {
    if (artist.canonicalId) {
      return { to: `/library/artist/${encodeURIComponent(artist.canonicalId)}` };
    }
    const to = resolveLibraryArtistPath({ mbid: getArtistId(artist), name: artist.name });
    return to ? { to } : null;
  }, []);

  const discoverArtistIds = useMemo(() => {
    const ids = new Set<string>();
    for (const artist of data?.recommendations || []) {
      const id = getArtistId(artist);
      if (id) ids.add(id);
    }
    for (const section of genreSections) {
      for (const artist of section.artists || []) {
        const id = getArtistId(artist);
        if (id) ids.add(id);
      }
    }
    for (const artist of recentlyAdded) {
      const id = artist?.mbid;
      if (id) ids.add(id);
    }
    return [...ids];
  }, [data, genreSections, recentlyAdded]);

  const discoverArtistIdsKey = discoverArtistIds.join(",");

  useEffect(() => {
    if (discoverArtistIds.length === 0) return;
    const cached = readLibraryLookupCache(discoverArtistIds);
    if (Object.keys(cached).length > 0) {
      setLibraryLookup((prev) => ({ ...prev, ...cached }));
    }
    const missing = discoverArtistIds.filter((id) => cached[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const fetchLookup = async () => {
      try {
        const lookup = await lookupArtistsInLibraryBatch(missing);
        if (!cancelled && lookup) {
          setLibraryLookup((prev) => ({ ...prev, ...lookup }));
        }
      } catch {
        console.warn("Failed to lookup artists in library");
      }
    };
    fetchLookup();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoverArtistIdsKey]);

  const openDiscoverModal = () => {
    setDraftSections(discoverSections.map((item) => ({ ...item })));
    setShowDiscoverModal(true);
  };

  const handleDiscoverSave = () => {
    saveDiscoverLayout(draftSections).catch((err) => {
      showError(err?.message || "Failed to save layout");
    });
  };

  const handleDiscoverReset = () => {
    setDraftSections(DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })));
  };

  const sectionPending = new Map([
    ["recentlyAdded", recentlyAddedPending],
    ["playlists", editorialShelfPending],
    ["recentReleases", recentReleasesPending],
  ]);

  const renderSection = ({ id, style: feedStyle = "list" }: DiscoverSection) => {
    if (sectionPending.get(id)) {
      return (
        <SkeletonStatus key={id} label="Loading section">
          <SkeletonRail kind={SECTION_CARD_KINDS.get(id)} />
        </SkeletonStatus>
      );
    }

    if (id === "recentlyAdded") {
      if (!sectionAvailability.recentlyAdded) return null;
      return (
        <DiscoverRail key="recentlyAdded" title="Recently added">
          <>
            {recentlyAdded.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => {
              const artistId = artist.mbid || null;
              const addedAt = new Date(artist.added || artist.addedAt || "");
              return (
                <div key={`artist-${artist.id}`} className="artist-discover-shelf-card">
                  <ArtistCard
                    hideLibraryCheck
                    isInLibrary={true}
                    getLibraryLink={getArtistLibraryLink}
                    artist={{
                      id: artistId,
                      canonicalId: artist.canonicalId || artist.id,
                      libraryPath: artistId
                        ? null
                        : `/library/artist/${encodeURIComponent(artist.canonicalId || artist.id)}`,
                      name: artist.artistName,
                      image: getLibraryArtistImage(artist),
                      type: "Artist",
                      metaText: "",
                      subtitle: `Added ${formatRelativeTime(addedAt, { unit: "day" })}`,
                      subtitleDetail: formatDate(addedAt),
                    }}
                  />
                </div>
              );
            })}
          </>
        </DiscoverRail>
      );
    }

    if (id === "playlists") {
      if (!sectionAvailability.playlists) return null;
      return (
        <DiscoverPlaylistSection
          key="playlists"
          title="Playlists"
          playlists={featuredPlaylists}
          showViewAll
        />
      );
    }

    if (id === "recentReleases") {
      if (!sectionAvailability.recentReleases) return null;
      return (
        <DiscoverRail key="recentReleases" title="Recent & upcoming releases">
          <>
            {recentReleases.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((album) => (
              <div
                key={album.id || album.mbid || album.foreignAlbumId}
                className="artist-discover-shelf-card"
              >
                <AlbumCard
                  album={album}
                  canAddAlbum={canAddAlbum}
                  isPending={!!pendingRecentReleaseIds[getRecentReleaseKey(album)]}
                  onAlbumAction={handleRecentReleaseAlbumAction}
                  libraryDestination={libraryDestination}
                />
              </div>
            ))}
          </>
        </DiscoverRail>
      );
    }

    if (id === "news") {
      if (!sectionAvailability.news) return null;
      const newsStatus = newsLoading
        ? null
        : newsError || newsRefresh?.warning || "No recent artist news";
      return (
        <DiscoverRail
          key="news"
          title="Artist news"
          viewAllTo="/discover/news"
          className={feedRailClass(feedStyle)}
        >
          {newsArticles.length > 0 ? (
            newsArticles
              .slice(0, feedItemLimit(feedStyle))
              .map((article) => (
                <NewsFeedTile
                  key={article.id}
                  article={article}
                  feedStyle={feedStyle}
                  onDisableFeed={authUser?.role === "admin" ? disableNewsFeed : undefined}
                />
              ))
          ) : newsStatus ? (
            <p className="discover-feed-rail__status">{newsStatus}</p>
          ) : (
            <SkeletonStatus label="Loading artist news" className="discover-feed-rail__skeleton">
              {feedSkeletons(feedStyle)}
            </SkeletonStatus>
          )}
        </DiscoverRail>
      );
    }

    if (id === "recommended") {
      if (!sectionAvailability.recommended) return null;
      if (recommendations.length > 0) {
        return (
          <DiscoverRail key="recommended" title="Recommended" viewAllTo={lastRecommendedPath()}>
            <>
              {recommendations.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                <div key={artist.id} className="artist-discover-shelf-card">
                  <ArtistCard
                    artist={{ ...artist, metaText: recommendationReason(artist, seeds) }}
                    isInLibrary={!!libraryLookup[String(getArtistId(artist))]}
                    getLibraryLink={getArtistLibraryLink}
                    onFeedback={handleDiscoveryFeedback}
                    feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                  />
                </div>
              ))}
              <div className="artist-discover-shelf-card">
                <ViewAllCard to={lastRecommendedPath()} />
              </div>
            </>
          </DiscoverRail>
        );
      }
      if (isUpdating) {
        return (
          <DiscoverRail
            key="recommended"
            title="Recommended"
            className="discover-rail--placeholder"
            afterTitle={
              <p className="discover-recommended-status" role="status">
                <DotLoader size="xs" label={null} />
                {updateProgressMessage || "Building your recommendations"}
              </p>
            }
          >
            {Array.from({ length: DISCOVER_PREVIEW_ITEM_LIMIT }, (_, index) => (
              <div key={index} className="artist-discover-shelf-card" aria-hidden="true">
                <SkeletonDiscoverCard index={index} />
              </div>
            ))}
          </DiscoverRail>
        );
      }
      return (
        <DiscoverRail key="recommended" title="Recommended" className="discover-rail--placeholder">
          <div className="discover-recommended-empty">
            <p className="discover-recommended-empty__message">
              Add artists you like to get recommendations.
            </p>
            <div className="discover-recommended-empty__actions">
              <RouteLink to="/search" className="btn btn-primary btn-sm">
                Search artists
              </RouteLink>
              <RouteLink to="/library" className="btn btn-secondary btn-sm">
                Browse Library
              </RouteLink>
            </div>
          </div>
        </DiscoverRail>
      );
    }

    if (id === "recommendedShows") {
      if (!sectionAvailability.recommendedShows) return null;
      const zipModeActive = nearbyLocationMode === "zip";
      const nearbyHeaderActions =
        nearbyShowsData?.configured !== false ? (
          <NearbyLocationControl
            locationMode={nearbyLocationMode}
            appliedZip={appliedNearbyZip}
            appliedCountry={appliedNearbyCountry}
            location={nearbyShowsData?.location}
            onSelectYourLocation={() => setNearbyLocationMode("ip")}
            onStartCustomLocation={() => setNearbyLocationMode("zip")}
            onApplyZip={setAppliedNearbyZip}
          />
        ) : null;
      if (nearbyShowsData?.configured === false) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">Ticketmaster not configured</h3>
              <p className="artist-nearby-status__text">
                {canManageServer
                  ? "Add a Ticketmaster key in Settings → Discovery to find nearby shows."
                  : "An admin needs to add a Ticketmaster key to find nearby shows."}
              </p>
              {canManageServer ? (
                <SettingsLink
                  to="discovery/ticketmaster"
                  className="btn btn-primary"
                  style={{ marginTop: "1rem" }}
                >
                  Open Settings
                </SettingsLink>
              ) : null}
            </div>
          </section>
        );
      }

      if (nearbyShowsLoading && !nearbyShowsData) {
        return (
          <DiscoverRail
            key="recommendedShows"
            title="Shows near you"
            viewAllTo="/shows"
            className={feedRailClass(feedStyle)}
          >
            <SkeletonStatus label="Loading shows near you" className="discover-feed-rail__skeleton">
              {feedSkeletons(feedStyle, feedStyle === "list")}
            </SkeletonStatus>
          </DiscoverRail>
        );
      }

      if (nearbyShowsError) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">Could not load nearby shows.</h3>
              {nearbyShowsError !== "This operation was aborted" ? (
                <p className="artist-nearby-status__text">{nearbyShowsError}</p>
              ) : null}
            </div>
          </section>
        );
      }

      if (zipModeActive && !appliedNearbyZip.trim()) {
        return (
          <DiscoverRail
            key="recommendedShows"
            title="Shows near you"
            viewAllTo="/shows"
            headerActions={nearbyHeaderActions}
          >
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">Location not set</h3>
              <p className="artist-nearby-status__text">
                Enter a ZIP or postal code, or use your location.
              </p>
            </div>
          </DiscoverRail>
        );
      }

      if (nearbyShows.length > 0) {
        return (
          <DiscoverRail
            key="recommendedShows"
            title="Shows near you"
            viewAllTo="/shows"
            headerActions={nearbyHeaderActions}
            className={feedRailClass(feedStyle)}
          >
            {nearbyShows.slice(0, feedItemLimit(feedStyle)).map((show) => (
              <ShowFeedTile key={show.id} show={show} feedStyle={feedStyle} />
            ))}
          </DiscoverRail>
        );
      }

      return (
        <section key="recommendedShows" className="artist-discover-section">
          <div className="artist-nearby-status">
            <h3 className="artist-nearby-status__title">
              No matching shows near {nearbyLocationLabel}.
            </h3>
          </div>
        </section>
      );
    }

    if (id === "globalTop") {
      if (!sectionAvailability.globalTop) return null;
      return (
        <TrendingArtistsRail
          key="globalTop"
          title="Trending artists"
          viewAllTo="/discover/trending"
          artists={(trendingArtists ?? []).slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)}
        />
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections">
          {genreSections.map((section) => {
            const viewAllPath = recommendedListPath({ genre: section.genre });
            return (
              <DiscoverRail
                key={section.genre}
                title={`Because you like ${section.genre}`}
                mobileTitle={section.genre}
                viewAllTo={viewAllPath}
              >
                <>
                  {section.artists.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                    <div
                      key={`${section.genre}-${artist.id}`}
                      className="artist-discover-shelf-card"
                    >
                      <ArtistCard
                        artist={{ ...artist, metaText: recommendationReason(artist, seeds) }}
                        isInLibrary={!!libraryLookup[String(getArtistId(artist))]}
                        getLibraryLink={getArtistLibraryLink}
                        onFeedback={handleDiscoveryFeedback}
                        feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                      />
                    </div>
                  ))}
                  <div className="artist-discover-shelf-card">
                    <ViewAllCard to={viewAllPath} />
                  </div>
                </>
              </DiscoverRail>
            );
          })}
        </div>
      );
    }

    return null;
  };

  const newestArtist = recentlyAdded[0];
  const tint = useArtistTint(
    getLibraryArtistImage(newestArtist),
    newestArtist?.mbid,
    newestArtist?.artistName,
  );

  const sectionMayRender = (id: string) =>
    (id !== "news" || newsConfigured) && (id !== "recommendedShows" || ticketmasterConfigured);

  if ((data === null && !error) || isActuallyUpdating) {
    const loadingMessage = isActuallyUpdating
      ? updateProgressMessage || "Building your recommendations"
      : "Loading recommendations";
    return (
      <div className="artist-discover-page" aria-busy="true">
        <section className="artist-discover-hero">
          <div className="artist-discover-hero__content">
            <div className="artist-discover-hero__header">
              <div className="artist-discover-hero__title-wrap">
                <div className="artist-discover-hero__title-row">
                  <h1 className="page-title">Discover</h1>
                  <DiscoveryStatusPill isUpdating updateProgressMessage={loadingMessage} />
                </div>
              </div>
              <SkeletonShape className="btn btn-icon-square btn-surface discover-page__customize-btn" />
            </div>
          </div>
        </section>
        <div aria-hidden="true">
          {discoverSections
            .filter((section) => section.enabled && sectionMayRender(section.id))
            .map((section) => (
              <SkeletonRail key={section.id} kind={SECTION_CARD_KINDS.get(section.id)} />
            ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="search-empty-panel" role="alert">
        <div className="search-empty-panel__icon" aria-hidden="true">
          <AlertCircle />
        </div>
        <h2 className="search-empty-panel__title">Couldn’t load Discover</h2>
        <p className="search-empty-panel__message">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn btn-secondary"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="artist-discover-page" style={tint ? { "--collection-tint": tint } : undefined}>
      <section className="artist-discover-hero">
        <div className="artist-discover-hero__content">
          <div className="artist-discover-hero__header">
            <div className="artist-discover-hero__title-wrap">
              <div className="artist-discover-hero__title-row">
                <h1 className="page-title">Discover</h1>
                <DiscoveryStatusPill
                  isUpdating={isUpdating}
                  updateProgressMessage={updateProgressMessage}
                  error={discoveryStatus?.error}
                />
              </div>
            </div>

            <TooltipButton
              type="button"
              onClick={openDiscoverModal}
              className="btn btn-icon-square btn-surface discover-page__customize-btn"
              aria-label="Customize Discover"
              title="Customize Discover"
            >
              <LayoutTemplate className="artist-discover-hero__customize-icon" />
            </TooltipButton>
          </div>
          {topGenres.length > 0 && (
            <div className="discover-tags">
              {topGenres.slice(0, TOP_TAG_LIMIT).map((genre) => (
                <RouteLink
                  key={genre}
                  to={`/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`}
                  className="discover-tag"
                >
                  {genre}
                </RouteLink>
              ))}
            </div>
          )}
        </div>
      </section>

      {discoverSections.filter((section) => section.enabled).map(renderSection)}

      <DiscoverLayoutModal
        open={showDiscoverModal}
        sections={draftSections}
        onSectionsChange={setDraftSections}
        sectionAvailability={sectionAvailability}
        isSaving={isSavingDiscoverLayout}
        onClose={() => setShowDiscoverModal(false)}
        onSave={handleDiscoverSave}
        onReset={handleDiscoverReset}
      />
    </div>
  );
}

export default DiscoverPage;
