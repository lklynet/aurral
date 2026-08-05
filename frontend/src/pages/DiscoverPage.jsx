import { useState, useEffect, useMemo, useCallback } from "react";
import { readLibraryLookupCache, lookupArtistsInLibraryBatch } from "../utils/api/endpoints/library.js";
import { getMyDiscoverLayout, updateMyDiscoverLayout } from "../utils/api/endpoints/auth.js";

import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import {
  Loader,
  Music,
  Sparkles,
  LayoutTemplate,
} from "lucide-react";
import DiscoveryStatusPill from "../components/DiscoveryStatusPill";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import LastfmBanner from "../components/LastfmBanner";
import { useToast } from "../contexts/ToastContext";
import { DiscoverRail } from "../components/DiscoverRail";
import { NewsArticleCard } from "../components/NewsArticleCard";
import { DiscoverLayoutModal } from "./DiscoverLayoutModal";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { AlbumCard, ArtistCard, ViewAllCard } from "./DiscoverCards";
import { useDiscoverLayoutState } from "./useDiscoverLayoutState";
import {
  getTagColor,
  DEFAULT_DISCOVER_SECTIONS,
  getFallbackGenreSectionId,
  getFallbackGenreFromSectionId,
  DISCOVER_PREVIEW_ITEM_LIMIT,
  normalizeDiscoverLayout,
  readStoredDiscoverLayout,
  writeStoredDiscoverLayout,
} from "./discoverUtils";
import { useDiscoverData } from "./useDiscoverData";
import { useLibraryNews } from "../hooks/useLibraryNews";
const getArtistId = (artist) => getArtistRecordId(artist);

function DiscoverPage() {
  useDocumentTitle("Discover");
  const { user: authUser, hasPermission, bootstrap } = useAuth();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();
  const canAdoptPlaylist = hasPermission("accessFlow");
  const newsConfigured = bootstrap?.newsapiConfigured === true;
  const {
    articles: newsArticles,
    loading: newsLoading,
    error: newsError,
    refresh: newsRefresh,
    blockPublisher: blockNewsPublisher,
  } = useLibraryNews({ enabled: newsConfigured, limit: 60 });

  const {
    data,
    recentlyAdded,
    recentReleases,
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
    setNearbyLocationMode,
    appliedNearbyZip,
    setAppliedNearbyZip,
    canAddArtist,
    canAddAlbum,
    getLibraryArtistImage,
    getRecentReleaseKey,
    handleAddArtistToLibrary,
    handleRecentReleaseAlbumAction,
    handleDiscoveryFeedback,
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
    if (Array.isArray(data?.fallbackGenres) && data.fallbackGenres.length > 0) {
      return data.fallbackGenres
        .map((section) => ({
          genre: section.name,
          artists: Array.isArray(section.artists) ? section.artists : [],
          fallback: true,
        }))
        .filter((section) => section.genre && section.artists.length > 0)
        .slice(0, 6);
    }

    if (!data?.topGenres || !data?.recommendations) return [];

    const sections = [];
    const usedArtistIds = new Set(
      (data.recommendations || [])
        .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
        .map((artist) => getArtistId(artist))
        .filter(Boolean),
    );

    const genres = [...data.topGenres];
    for (let i = genres.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [genres[i], genres[j]] = [genres[j], genres[i]];
    }
    const candidatePool = [...(data.recommendations || [])].slice(8);

    for (const genre of genres) {
      if (sections.length >= 12) break;

      const genreArtists = candidatePool.filter((artist) => {
        const artistId = getArtistId(artist);
        if (artistId && usedArtistIds.has(artistId)) return false;

        const artistTags = artist.matchedTags || artist.tags || [];
        return artistTags.some((tag) => tag.toLowerCase().includes(genre.toLowerCase()));
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
      (data.topGenres && data.topGenres.length > 0) ||
      (data.fallbackGenres && data.fallbackGenres.length > 0));
  const isActuallyUpdating = data?.isUpdating && !hasData;

  const {
    recommendations = [],
    globalTop = [],
    topGenres = [],
    basedOn = [],
    discoverPlaylists = [],
    provider = "lastfm",
    capabilities,
    lastUpdated,
    isUpdating,
    updateProgressMessage,
    playlistsUpdating,
    playlistsUpdateMessage,
    configured = true,
  } = data || {};
  const [adoptedFlowIds, setAdoptedFlowIds] = useState({});
  const [adoptedStaticPlaylistIds, setAdoptedStaticPlaylistIds] = useState({});
  const isListenBrainzFallback = provider === "listenbrainz-fallback";

  const nearbyShows = nearbyShowsData?.shows || [];
  const nearbyLocationLabel =
    nearbyShowsData?.location?.label || nearbyShowsData?.location?.postalCode || "your area";
  const displayDiscoverPlaylists = useMemo(
    () =>
      discoverPlaylists.map((playlist) => ({
        ...playlist,
        adoptedFlowId: playlist.adoptedFlowId || adoptedFlowIds[playlist.presetId] || null,
        adoptedPlaylistId:
          playlist.adoptedPlaylistId || adoptedStaticPlaylistIds[playlist.presetId] || null,
      })),
    [adoptedFlowIds, adoptedStaticPlaylistIds, discoverPlaylists],
  );

  useEffect(() => {
    setAdoptedFlowIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const playlist of discoverPlaylists) {
        if (playlist.adoptedFlowId) {
          if (next[playlist.presetId] !== playlist.adoptedFlowId) {
            next[playlist.presetId] = playlist.adoptedFlowId;
            changed = true;
          }
        } else if (next[playlist.presetId]) {
          delete next[playlist.presetId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setAdoptedStaticPlaylistIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const playlist of discoverPlaylists) {
        if (playlist.adoptedPlaylistId) {
          if (next[playlist.presetId] !== playlist.adoptedPlaylistId) {
            next[playlist.presetId] = playlist.adoptedPlaylistId;
            changed = true;
          }
        } else if (next[playlist.presetId]) {
          delete next[playlist.presetId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoverPlaylists]);

  const handleFlowAdopted = useCallback((presetId, flowId) => {
    if (!presetId || !flowId) return;
    setAdoptedFlowIds((prev) => ({ ...prev, [presetId]: flowId }));
  }, []);

  const handleStaticPlaylistAdopted = useCallback((presetId, playlistId) => {
    if (!presetId || !playlistId) return;
    setAdoptedStaticPlaylistIds((prev) => ({
      ...prev,
      [presetId]: playlistId,
    }));
  }, []);

  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      playlists: displayDiscoverPlaylists.length > 0 || !!playlistsUpdating,
      recentReleases: recentReleases.length > 0,
      news: newsConfigured,
      recommended:
        !isListenBrainzFallback &&
        (recommendations.length > 0 ||
          isUpdating ||
          capabilities?.personalizedRecommendations !== false),
      recommendedShows: ticketmasterConfigured,
      globalTop: globalTop.length > 0,
      genreSections: genreSections.length > 0,
    }),
    [
      recentlyAdded,
      displayDiscoverPlaylists,
      playlistsUpdating,
      recentReleases,
      newsConfigured,
      globalTop,
      genreSections,
      recommendations,
      capabilities,
      isListenBrainzFallback,
      isUpdating,
      ticketmasterConfigured,
    ],
  );

  const fallbackGenreSections = useMemo(
    () =>
      isListenBrainzFallback
        ? genreSections.map((section) => ({
            id: getFallbackGenreSectionId(section.genre),
            label: `Top ${section.genre} Artists`,
            enabled: true,
          }))
        : [],
    [genreSections, isListenBrainzFallback],
  );

  const displayDiscoverSections = useMemo(() => {
    const sectionsById = new Map(discoverSections.map((item) => [item.id, item]));
    if (!isListenBrainzFallback) {
      return discoverSections.filter((item) => !getFallbackGenreFromSectionId(item.id));
    }

    const dynamicGenresById = new Map(
      fallbackGenreSections.map((section) => [section.id, section]),
    );
    const nextSections = [];
    const seenGenreIds = new Set();
    let lastGenreIndex = -1;

    for (const item of discoverSections) {
      if (
        item.id === "recommended" ||
        item.id === "recommendedShows" ||
        item.id === "genreSections"
      ) {
        continue;
      }

      const fallbackGenre = getFallbackGenreFromSectionId(item.id);
      if (fallbackGenre) {
        const dynamicSection = dynamicGenresById.get(item.id);
        if (!dynamicSection || seenGenreIds.has(item.id)) continue;
        seenGenreIds.add(item.id);
        lastGenreIndex = nextSections.length;
        nextSections.push({
          ...dynamicSection,
          enabled: item.enabled,
        });
        continue;
      }

      nextSections.push(item);
    }

    const missingGenreSections = fallbackGenreSections
      .filter((section) => !seenGenreIds.has(section.id))
      .map((section) => ({
        ...section,
        enabled:
          sectionsById.get("genreSections")?.enabled ??
          sectionsById.get(section.id)?.enabled ??
          section.enabled,
      }));

    const insertionIndex = lastGenreIndex >= 0 ? lastGenreIndex + 1 : -1;
    nextSections.splice(
      insertionIndex === -1 ? nextSections.length : insertionIndex,
      0,
      ...missingGenreSections,
    );
    return nextSections;
  }, [discoverSections, fallbackGenreSections, isListenBrainzFallback]);

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

  const navigateToBasedOnArtist = useCallback(
    (artist) => {
      const routeId =
        artist?.id || artist?.mbid || (artist?.name ? encodeURIComponent(artist.name) : "");
      if (!routeId) return;
      navigate(`/artist/${routeId}`, {
        state: { artistName: artist.name },
      });
    },
    [navigate],
  );

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
      const id = artist?.foreignArtistId || artist?.mbid || artist?.id;
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
    setDraftSections(displayDiscoverSections.map((item) => ({ ...item })));
    setShowDiscoverModal(true);
  };

  const handleDiscoverSave = () => {
    saveDiscoverLayout(draftSections).catch((err) => {
      showError(err?.message || "Failed to save layout");
    });
  };

  const handleDiscoverReset = () => {
    setDraftSections(
      isListenBrainzFallback
        ? displayDiscoverSections.map((item) => ({ ...item, enabled: true }))
        : DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })),
    );
  };

  const renderSection = (id) => {
    const fallbackGenre = getFallbackGenreFromSectionId(id);
    if (fallbackGenre) {
      const section = genreSections.find((item) => item.genre === fallbackGenre);
      if (!section || section.artists.length === 0) return null;
      return (
        <DiscoverRail
          key={id}
          title={`Top ${section.genre} Artists`}
          mobileTitle={section.genre}
          onViewAll={() =>
            navigate(`/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`)
          }
        >
          <>
            {section.artists.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
              <div key={`${section.genre}-${artist.id}`} className="artist-discover-shelf-card">
                <ArtistCard
                  artist={artist}
                  isInLibrary={!!libraryLookup[getArtistId(artist)]}
                  canAddArtist={canAddArtist}
                  onNavigate={navigate}
                  onAddToLibrary={handleAddArtistToLibrary}
                  onFeedback={handleDiscoveryFeedback}
                  feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                />
              </div>
            ))}
            <div className="artist-discover-shelf-card">
              <ViewAllCard
                onClick={() =>
                  navigate(`/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`)
                }
              />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "recentlyAdded") {
      if (!sectionAvailability.recentlyAdded) return null;
      return (
        <DiscoverRail key="recentlyAdded" title="Recently Added">
          <>
            {recentlyAdded.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => {
              const artistId = artist.foreignArtistId || artist.mbid || artist.id;
              return (
                <div key={`artist-${artist.id}`} className="artist-discover-shelf-card">
                  <ArtistCard
                    status="available"
                    isInLibrary={!!libraryLookup[artistId]}
                    canAddArtist={false}
                    onNavigate={navigate}
                    artist={{
                      id: artistId,
                      name: artist.artistName,
                      image: getLibraryArtistImage(artist),
                      type: "Artist",
                      metaText: "",
                      subtitle: `Added ${new Date(
                        artist.added || artist.addedAt,
                      ).toLocaleDateString()}`,
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
          playlists={displayDiscoverPlaylists}
          artworkVersion={lastUpdated}
          canAdopt={canAdoptPlaylist}
          playlistsUpdating={playlistsUpdating}
          playlistsUpdateMessage={playlistsUpdateMessage}
          onFlowAdopted={handleFlowAdopted}
          onPlaylistAdopted={handleStaticPlaylistAdopted}
        />
      );
    }

    if (id === "recentReleases") {
      if (!sectionAvailability.recentReleases) return null;
      return (
        <DiscoverRail key="recentReleases" title="Recent & Upcoming Releases">
          <>
            {recentReleases.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((album) => (
              <div
                key={album.id || album.mbid || album.foreignAlbumId}
                className="artist-discover-shelf-card"
              >
                <AlbumCard
                  album={album}
                  onNavigate={navigate}
                  canAddAlbum={canAddAlbum}
                  isPending={!!pendingRecentReleaseIds[getRecentReleaseKey(album)]}
                  onAlbumAction={handleRecentReleaseAlbumAction}
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
          title="Artist News"
          onViewAll={() => navigate("/discover/news")}
        >
          {newsLoading && newsArticles.length === 0 ? (
            <div className="discover-news-rail-status artist-discover-shelf-card--news-status">
              Checking recent stories…
            </div>
          ) : newsArticles.length > 0 ? (
            newsArticles.slice(0, 12).map((article) => (
              <div key={article.url} className="artist-discover-shelf-card artist-discover-shelf-card--news">
                <NewsArticleCard
                  article={article}
                  compact
                  onBlockPublisher={blockNewsPublisher}
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
            title="Recommended for You"
            onViewAll={() => navigate("/search?type=recommended")}
          >
            <>
              {recommendations.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                <div key={artist.id} className="artist-discover-shelf-card">
                  <ArtistCard
                    artist={artist}
                    isInLibrary={!!libraryLookup[getArtistId(artist)]}
                    canAddArtist={canAddArtist}
                    onNavigate={navigate}
                    onAddToLibrary={handleAddArtistToLibrary}
                    onFeedback={handleDiscoveryFeedback}
                    feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                  />
                </div>
              ))}
              <div className="artist-discover-shelf-card">
                <ViewAllCard onClick={() => navigate("/search?type=recommended")} />
              </div>
            </>
          </DiscoverRail>
        );
      }
      return (
        <section key="recommended" className="artist-discover-section">
          <h2 className="artist-section-title--discover discover-recommended-status__title">
            <span className="artist-section-title--discover-mobile">Recommended</span>
            <span className="artist-section-title--discover-desktop">Recommended for You</span>
          </h2>
          <div
            className={`discover-recommended-status${isUpdating ? " discover-recommended-status--loading" : ""}`}
          >
            {isUpdating ? (
              <Loader className="discover-recommended-status__spinner animate-spin" />
            ) : (
              <div className="discover-recommended-status__icon" aria-hidden="true">
                <Music className="artist-icon-lg" />
              </div>
            )}
            <h3 className="discover-recommended-status__heading">
              {isUpdating
                ? "Building your recommendations"
                : provider === "lastfm"
                  ? "Not enough listening data yet"
                  : "Connect Last.fm"}
            </h3>
            <p className="discover-recommended-status__message">
              {isUpdating
                ? updateProgressMessage ||
                  "Scanning your library and Last.fm history. The first setup can take up to 10 minutes."
                : provider === "lastfm"
                  ? "Add artists to your library or keep scrobbling on Last.fm. Recommendations improve as Aurral learns your taste."
                  : "Connect a Last.fm API key for personalized recommendations, related artists, and flows."}
            </p>
            {!isUpdating ? (
              <div className="discover-recommended-status__actions">
                {provider !== "lastfm" ? (
                  <button
                    type="button"
                    onClick={() => navigate("/settings/connect")}
                    className="btn btn-primary btn--bold btn-min-h"
                  >
                    Connect Last.fm
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate("/search")}
                    className="btn btn-primary btn--bold btn-min-h"
                  >
                    Search Artists
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => navigate("/library")}
                  className="btn btn-secondary btn--bold btn-min-h"
                >
                  Browse Library
                </button>
              </div>
            ) : null}
          </div>
        </section>
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
                Add a Ticketmaster Consumer Key in Settings to enable local show discovery on this
                page.
              </p>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="btn btn-primary"
                style={{ marginTop: "1rem" }}
              >
                Open Settings
              </button>
            </div>
          </section>
        );
      }

      if (nearbyShowsLoading && !nearbyShowsData) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status artist-nearby-status--loading">
              <Loader className="artist-nearby-status__spinner animate-spin" />
            </div>
          </section>
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
            title="Shows Near You"
            onViewAll={() => navigate("/shows")}
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
            title="Shows Near You"
            onViewAll={() => navigate("/shows")}
            headerActions={nearbyHeaderActions}
          >
            <>
              {nearbyShows.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((show) => (
                <div
                  key={`${show.id}-${show.artistName}-${show.sourceType || "show"}`}
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
          title="Global Trending"
          onViewAll={() => navigate("/search?type=trending")}
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
                  canAddArtist={canAddArtist}
                  onNavigate={navigate}
                  onAddToLibrary={handleAddArtistToLibrary}
                  onFeedback={handleDiscoveryFeedback}
                  feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                />
              </div>
            ))}
            <div className="artist-discover-shelf-card">
              <ViewAllCard onClick={() => navigate("/search?type=trending")} />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections">
          {genreSections.map((section) => (
            <DiscoverRail
              key={section.genre}
              title={
                section.fallback
                  ? `Top ${section.genre} Artists`
                  : `Because You Like ${section.genre}`
              }
              mobileTitle={section.genre}
              onViewAll={() =>
                navigate(`/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`)
              }
            >
              <>
                {section.artists.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
                  <div key={`${section.genre}-${artist.id}`} className="artist-discover-shelf-card">
                    <ArtistCard
                      artist={artist}
                      isInLibrary={!!libraryLookup[getArtistId(artist)]}
                      canAddArtist={canAddArtist}
                      onNavigate={navigate}
                      onAddToLibrary={handleAddArtistToLibrary}
                      onFeedback={handleDiscoveryFeedback}
                      feedbackUsed={getArtistFeedbackFlags(artistFeedbackLookup, artist)}
                    />
                  </div>
                ))}
                <div className="artist-discover-shelf-card">
                  <ViewAllCard
                    onClick={() =>
                      navigate(`/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`)
                    }
                  />
                </div>
              </>
            </DiscoverRail>
          ))}
        </div>
      );
    }

    return null;
  };

  const [showFullBasedOnList, setShowFullBasedOnList] = useState(false);

  if (data === null && !error) {
    return (
      <div className="artist-loading--discover">
        <Loader className="artist-spinner--discover animate-spin" />
        <h2 className="artist-error-title--discover">Loading recommendations...</h2>
        <p className="artist-error-copy--discover">Recommendations will appear as they load.</p>
      </div>
    );
  }

  if (isActuallyUpdating) {
    return (
      <div className="artist-loading--discover">
        <Loader className="artist-spinner--discover animate-spin" />
        <h2 className="artist-error-title--discover">
          {isListenBrainzFallback
            ? "Loading ListenBrainz discovery..."
            : "Building your recommendations..."}
        </h2>
        <p className="artist-error-copy--discover">
          {isListenBrainzFallback
            ? "The app is loading trending artists and default genre shelves."
            : "The app is scanning your library and Last.fm data. Please wait. This can take up to 10 minutes when Last.fm is configured. The page will update when ready."}
        </p>
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
          Try Again
        </button>
      </div>
    );
  }

  if (configured === false && !recommendations.length && !globalTop.length && !topGenres.length) {
    return (
      <div className="artist-empty-panel--discover-not-configured">
        <div className="artist-error-icon">
          <Sparkles className="artist-icon-lg" />
        </div>
        <h2 className="artist-error-title">Discovery Not Configured</h2>
        <p className="artist-empty-message">
          To see music recommendations, you need at least one of:
        </p>
        <ul>
          <li>
            <span>•</span>
            <span>Add artists to your library, or</span>
          </li>
          <li>
            <span>•</span>
            <span>Configure Last.fm (API key and username) in Settings</span>
          </li>
        </ul>
        <button onClick={() => navigate("/settings/connect")} className="btn btn-primary">
          Connect Last.fm
        </button>
      </div>
    );
  }

  return (
    <div className="artist-discover-page">
      <LastfmBanner />
      <section className="artist-discover-hero">
        <div className="artist-discover-hero__content">
          <div className="artist-discover-hero__header">
            <div className="artist-discover-hero__title-wrap">
              <div className="artist-discover-hero__title-row">
                <h1 className="page-title">Discover</h1>
                <DiscoveryStatusPill
                  isUpdating={isUpdating}
                  playlistsUpdating={playlistsUpdating}
                  lastUpdated={lastUpdated}
                  updateProgressMessage={updateProgressMessage}
                  playlistsUpdateMessage={playlistsUpdateMessage}
                />
              </div>
              <p className="artist-discover-hero__description">
                Your daily mix, curated from your library.
              </p>
              {heroBasedOn.length > 0 && (
                <div className="artist-discover-hero__based-on">
                  <div className="artist-discover-hero__based-on-intro">Based on:</div>
                  {showFullBasedOnList ? (
                    <div className="artist-discover-hero__artists-expanded">
                      {heroBasedOn.map((artist, index) => (
                        <button
                          key={index}
                          onClick={() => navigateToBasedOnArtist(artist)}
                          className="artist-discover-hero__artist-tag"
                        >
                          {artist.name}
                        </button>
                      ))}
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
                        <button
                          onClick={() => navigateToBasedOnArtist(heroBasedOn[0])}
                          className="artist-discover-hero__artist-tag"
                        >
                          {heroBasedOn[0].name}
                        </button>
                      ) : (
                        <>
                          {heroBasedOn.slice(0, 4).map((artist, index) => (
                            <button
                              key={index}
                              onClick={() => navigateToBasedOnArtist(artist)}
                              className="artist-discover-hero__artist-tag"
                            >
                              {artist.name}
                            </button>
                          ))}
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

            <button
              type="button"
              onClick={openDiscoverModal}
              className="btn btn-sm btn-surface discover-page__customize-btn"
            >
              <LayoutTemplate className="artist-discover-hero__customize-icon" />
              <span>Customize</span>
            </button>
          </div>

          <div className="artist-discover-hero__tags-section">
            {topGenres.length > 0 && (
              <div>
                <h3 className="artist-discover-hero__tags-section-title">Top tags:</h3>
                <div className="artist-tag-list--discover">
                  {topGenres.slice(0, 30).map((genre, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        navigate(`/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`)
                      }
                      className="artist-tag--discover"
                      style={{
                        backgroundColor: getTagColor(genre),
                      }}
                    >
                      #{genre}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {displayDiscoverSections
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
