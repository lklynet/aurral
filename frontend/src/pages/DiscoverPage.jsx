import { useState, useEffect, useMemo, useCallback } from "react";
import {
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
} from "../utils/api/endpoints/library.js";
import { getMyDiscoverLayout, updateMyDiscoverLayout } from "../utils/api/endpoints/auth.js";

import { Sparkles, LayoutTemplate } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { SkeletonRail, SkeletonStatus } from "../components/Skeletons";
import { resolveLibraryArtistPath } from "../navigation/resolveLinks.js";
import DiscoveryStatusPill from "../components/DiscoveryStatusPill";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import { useToast } from "../contexts/ToastContext";
import { DiscoverRail } from "../components/DiscoverRail";
import { NewsArticleCard } from "../components/NewsArticleCard";
import { DiscoverLayoutModal } from "./DiscoverLayoutModal";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { useEditorialShelf } from "./useEditorialShelf";
import { AlbumCard, ArtistCard, ViewAllCard } from "./DiscoverCards";
import { useDiscoverLayoutState } from "./useDiscoverLayoutState";
import {
  DEFAULT_DISCOVER_SECTIONS,
  DISCOVER_PREVIEW_ITEM_LIMIT,
  artistMatchesGenre,
  shuffleWithSeed,
  normalizeDiscoverLayout,
  readStoredDiscoverLayout,
  writeStoredDiscoverLayout,
} from "./discoverUtils";
import { useDiscoverData } from "./useDiscoverData";
import { useLibraryNews } from "../hooks/useLibraryNews";
import { formatDate, formatRelativeTime } from "../utils/dateTime.js";
import TooltipButton from "../components/TooltipButton";
import RouteLink from "../components/RouteLink";
const getArtistId = (artist) => getArtistRecordId(artist);

const SQUARE_ART_SECTIONS = new Set(["playlists", "recentReleases", "recommendedShows", "news"]);

function DiscoverPage() {
  useDocumentTitle("Discover");
  const { user: authUser, bootstrap } = useAuth();
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
    loadServerLayout: getMyDiscoverLayout,
    saveServerLayout: updateMyDiscoverLayout,
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
  const lastUpdated = discoveryStatus?.lastUpdated || data?.lastUpdated || null;
  const isActuallyUpdating = isUpdating && !hasData;

  const {
    recommendations = [],
    globalTop = [],
    topGenres = [],
    basedOn = [],
  } = data || {};
  const { data: editorialShelf, isPending: editorialShelfPending } = useEditorialShelf();

  const nearbyShows = nearbyShowsData?.shows || [];
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
      globalTop: globalTop.length > 0,
      genreSections: genreSections.length > 0,
    }),
    [
      recentlyAdded,
      featuredPlaylists,
      recentReleases,
      newsConfigured,
      globalTop,
      genreSections,
      ticketmasterConfigured,
    ],
  );

  const heroBasedOn = useMemo(() => {
    if (basedOn && basedOn.length > 0) return basedOn;
    const seen = new Set();
    const names = [];
    for (const r of recommendations || []) {
      const name = r.sourceArtist || r.source;
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push({ name });
      }
    }
    return names;
  }, [basedOn, recommendations]);

  const renderBasedOnArtist = (artist, key) => {
    const routeId =
      artist?.id || artist?.mbid || (artist?.name ? encodeURIComponent(artist.name) : "");
    if (!routeId) {
      return (
        <span key={key} className="artist-discover-hero__artist-tag">
          {artist?.name}
        </span>
      );
    }
    return (
      <RouteLink
        key={key}
        to={`/artist/${routeId}`}
        state={{ artistName: artist.name }}
        className="artist-discover-hero__artist-tag"
      >
        {artist.name}
      </RouteLink>
    );
  };

  const getArtistLibraryLink = useCallback((artist) => {
    if (artist.canonicalId) {
      return { to: `/library/artist/${encodeURIComponent(artist.canonicalId)}` };
    }
    const to = resolveLibraryArtistPath({ mbid: getArtistId(artist), name: artist.name });
    return to ? { to } : null;
  }, []);

  const discoverArtistIds = useMemo(() => {
    const ids = new Set();
    for (const artist of data?.recommendations || []) {
      const id = getArtistId(artist);
      if (id) ids.add(id);
    }
    for (const artist of data?.globalTop || []) {
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

  const sectionPending = {
    recentlyAdded: recentlyAddedPending,
    playlists: editorialShelfPending,
    recentReleases: recentReleasesPending,
  };

  const renderSection = (id) => {
    if (sectionPending[id]) {
      return (
        <SkeletonStatus key={id} label="Loading section">
          <SkeletonRail square={SQUARE_ART_SECTIONS.has(id)} />
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
              return (
                <div key={`artist-${artist.id}`} className="artist-discover-shelf-card">
                  <ArtistCard
                    status="available"
                    isInLibrary={true}
                    getLibraryLink={getArtistLibraryLink}
                    artist={{
                      id: artistId,
                      canonicalId: artist.canonicalId || artist.id,
                      libraryPath: artistId ? null : `/library/artist/${encodeURIComponent(artist.canonicalId || artist.id)}`,
                      name: artist.artistName,
                      image: getLibraryArtistImage(artist),
                      type: "Artist",
                      metaText: "",
                      subtitle: `Added ${formatRelativeTime(new Date(artist.added || artist.addedAt), { unit: "day" })}`,
                      subtitleDetail: formatDate(new Date(artist.added || artist.addedAt)),
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
      return (
        <DiscoverRail
          key="news"
          title="Artist news"
          viewAllTo="/discover/news"
        >
          {newsLoading && newsArticles.length === 0 ? (
            <div className="discover-news-rail-status artist-discover-shelf-card--news-status">
              <DotLoader size="sm" label={null} /> Checking recent stories…
            </div>
          ) : newsArticles.length > 0 ? (
            newsArticles.map((article) => (
              <div key={article.id} className="artist-discover-shelf-card artist-discover-shelf-card--news">
                <NewsArticleCard
                  article={article}
                  compact
                  onDisableFeed={authUser?.role === "admin" ? disableNewsFeed : undefined}
                />
              </div>
            ))
          ) : (
            <div className="discover-news-rail-status artist-discover-shelf-card--news-status">
              {newsError || newsRefresh?.warning || "No recent artist news"}
            </div>
          )}
        </DiscoverRail>
      );
    }

    if (id === "recommended") {
      if (!sectionAvailability.recommended) return null;
      if (recommendations.length > 0) {
        return (
          <DiscoverRail
            key="recommended"
            title="Recommended"
            viewAllTo="/search?type=recommended"
          >
            <>
              {recommendations.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                <div key={artist.id} className="artist-discover-shelf-card">
                  <ArtistCard
                    artist={artist}
                    isInLibrary={!!libraryLookup[getArtistId(artist)]}
                    getLibraryLink={getArtistLibraryLink}
                    onFeedback={handleDiscoveryFeedback}
                    feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                  />
                </div>
              ))}
              <div className="artist-discover-shelf-card">
                <ViewAllCard to="/search?type=recommended" />
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
                <div className="discover-skeleton-card">
                  <div className="discover-skeleton-card__cover" />
                  <div className="discover-skeleton-card__line" />
                  <div className="discover-skeleton-card__line discover-skeleton-card__line--short" />
                </div>
              </div>
            ))}
          </DiscoverRail>
        );
      }
      return (
        <DiscoverRail
          key="recommended"
          title="Recommended"
          className="discover-rail--placeholder"
        >
          <div className="discover-recommended-empty">
            <p className="discover-recommended-empty__message">
              Not enough listening data yet. Add a few artists you like to get started.
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
                Add a Ticketmaster consumer key in Settings to enable local show discovery on this
                page.
              </p>
              <RouteLink
                to="/settings"
                className="btn btn-primary"
                style={{ marginTop: "1rem" }}
              >
                Open Settings
              </RouteLink>
            </div>
          </section>
        );
      }

      if (nearbyShowsLoading && !nearbyShowsData) {
        return (
          <SkeletonStatus key="recommendedShows" label="Loading shows near you">
            <SkeletonRail />
          </SkeletonStatus>
        );
      }

      if (nearbyShowsError) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">Unable to load nearby shows</h3>
              <p className="artist-nearby-status__text">{nearbyShowsError}</p>
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
                Open the location menu and enter a ZIP or postal code, or choose Your location.
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
          >
            <>
              {nearbyShows.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((show) => (
                <div
                  key={show.id}
                  className="artist-discover-show-rail-card"
                >
                  <ShowCard show={show} />
                </div>
              ))}
            </>
          </DiscoverRail>
        );
      }

      return (
        <section key="recommendedShows" className="artist-discover-section">
          <div className="artist-nearby-status">
            <h3 className="artist-nearby-status__title">No upcoming nearby matches</h3>
            <p className="artist-nearby-status__text">
              We could not find local Ticketmaster shows tied to your library or current
              recommendations around {nearbyLocationLabel}.
            </p>
          </div>
        </section>
      );
    }

    if (id === "globalTop") {
      if (!sectionAvailability.globalTop) return null;
      return (
        <DiscoverRail
          key="globalTop"
          title="Global trending"
          viewAllTo="/search?type=trending"
        >
          <>
            {globalTop.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
              <div key={artist.id} className="artist-discover-shelf-card">
                <ArtistCard
                  artist={{
                    ...artist,
                    metaText: "",
                  }}
                  isInLibrary={!!libraryLookup[getArtistId(artist)]}
                  getLibraryLink={getArtistLibraryLink}
                  onFeedback={handleDiscoveryFeedback}
                  feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                />
              </div>
            ))}
            <div className="artist-discover-shelf-card">
              <ViewAllCard to="/search?type=trending" />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections">
          {genreSections.map((section) => {
            const viewAllPath = `/search?type=recommended&tag=${encodeURIComponent(section.genre)}`;
            return (
              <DiscoverRail
                key={section.genre}
                title={`Because you like ${section.genre}`}
                mobileTitle={section.genre}
                viewAllTo={viewAllPath}
              >
                <>
                  {section.artists.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                    <div key={`${section.genre}-${artist.id}`} className="artist-discover-shelf-card">
                      <ArtistCard
                        artist={artist}
                        isInLibrary={!!libraryLookup[getArtistId(artist)]}
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

  const [showFullBasedOnList, setShowFullBasedOnList] = useState(false);

  const sectionMayRender = (id) =>
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
                </div>
                <p className="discover-recommended-status" role="status">
                  <DotLoader size="xs" label={null} />
                  {loadingMessage}
                </p>
              </div>
            </div>
          </div>
        </section>
        <div aria-hidden="true">
          {discoverSections
            .filter((section) => section.enabled && sectionMayRender(section.id))
            .map((section) => (
              <SkeletonRail key={section.id} square={SQUARE_ART_SECTIONS.has(section.id)} />
            ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="artist-error-panel--discover">
        <Sparkles className="artist-error-icon--discover" />
        <h2 className="artist-error-title--discover">Unable to load discovery</h2>
        <p className="artist-empty-message--discover">{error}</p>
        <button onClick={() => window.location.reload()} className="btn btn-primary">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="artist-discover-page">
      <section className="artist-discover-hero">
        <div className="artist-discover-hero__content">
          <div className="artist-discover-hero__header">
            <div className="artist-discover-hero__title-wrap">
              <div className="artist-discover-hero__title-row">
                <h1 className="page-title">Discover</h1>
                <DiscoveryStatusPill
                  isUpdating={isUpdating}
                  lastUpdated={lastUpdated}
                  updateProgressMessage={updateProgressMessage}
                  error={discoveryStatus?.error}
                />
              </div>
              {heroBasedOn.length > 0 && (
                <div className="artist-discover-hero__based-on">
                  <div className="artist-discover-hero__based-on-intro">Based on:</div>
                  {showFullBasedOnList ? (
                    <div className="artist-discover-hero__artists-expanded">
                      {heroBasedOn.map((artist, index) => renderBasedOnArtist(artist, index))}
                      <button
                        onClick={() => setShowFullBasedOnList(false)}
                        className="artist-discover-hero__view-toggle-badge"
                      >
                        view less
                      </button>
                    </div>
                  ) : (
                    <div className="artist-discover-hero__artists-collapsed">
                      {heroBasedOn.length === 1 ? (
                        renderBasedOnArtist(heroBasedOn[0], 0)
                      ) : (
                        <>
                          {heroBasedOn
                            .slice(0, 4)
                            .map((artist, index) => renderBasedOnArtist(artist, index))}
                          {heroBasedOn.length > 4 && (
                            <button
                              onClick={() => setShowFullBasedOnList(true)}
                              className="artist-discover-hero__view-toggle-badge"
                            >
                              +{heroBasedOn.length - 4} more
                            </button>
                          )}                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
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

          <div className="artist-discover-hero__tags-section">
            {topGenres.length > 0 && (
              <div>
                <h3 className="artist-discover-hero__tags-section-title">Top tags:</h3>
                <div className="artist-tag-list--discover">
                  {topGenres.slice(0, 30).map((genre, i) => (
                    <RouteLink
                      key={i}
                      to={`/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`}
                      className="artist-tag--discover"
                    >
                      #{genre}
                    </RouteLink>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {discoverSections
        .filter((section) => section.enabled)
        .map((section) => renderSection(section.id))}

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
