import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Loader, Music, MapPin, AlertCircle } from "lucide-react";
import { getNearbyShows } from "../utils/api";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";

const NEARBY_MODE_KEY = "discoverNearbyMode";
const NEARBY_ZIP_KEY = "discoverNearbyZip";
const SHOWS_PAGE_LIMIT = 60;
const SHOW_FILTER_OPTIONS = [
  { id: "all", label: "All" },
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" },
];

const DEFAULT_LOCATION_STATE = {
  locationMode: "ip",
  appliedZip: "",
};

const readStoredLocationState = () => {
  try {
    const storedMode = globalThis.localStorage?.getItem(NEARBY_MODE_KEY);
    const storedZip = globalThis.localStorage?.getItem(NEARBY_ZIP_KEY) || "";
    return {
      locationMode:
        storedMode === "zip" || storedMode === "ip"
          ? storedMode
          : DEFAULT_LOCATION_STATE.locationMode,
      appliedZip: storedZip,
    };
  } catch {
    return DEFAULT_LOCATION_STATE;
  }
};

const writeStoredLocationMode = (mode) => {
  try {
    globalThis.localStorage?.setItem(NEARBY_MODE_KEY, mode);
  } catch {}
};

const writeStoredZip = (zipCode) => {
  try {
    globalThis.localStorage?.setItem(NEARBY_ZIP_KEY, zipCode);
  } catch {}
};

const getShowGroups = (showsData) => ({
  all: Array.isArray(showsData?.shows) ? showsData.shows : [],
  library: Array.isArray(showsData?.libraryShows) ? showsData.libraryShows : [],
  discover: Array.isArray(showsData?.recommendedShows)
    ? showsData.recommendedShows
    : [],
});

const getSafeCount = (value, fallback) => {
  if (value == null || value === "") return fallback;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

const getShowKey = (show, index) =>
  [
    show?.id || `show-${index}`,
    show?.artistName,
    show?.sourceType || show?.matchType || "show",
  ]
    .filter(Boolean)
    .join("-");

function ShowsPage() {
  useDocumentTitle("Shows");
  const navigate = useNavigate();
  const [showsData, setShowsData] = useState(null);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsError, setShowsError] = useState(null);
  const [showFilter, setShowFilter] = useState("all");
  const [{ locationMode, appliedZip }, setLocationState] = useState(
    readStoredLocationState,
  );
  const zipModeActive = locationMode === "zip";

  useEffect(() => {
    const shouldUseZip = locationMode === "zip";
    const trimmedZip = appliedZip.trim();
    if (shouldUseZip && !trimmedZip) {
      setShowsData(null);
      setShowsError(null);
      setShowsLoading(false);
      return;
    }

    const controller = new AbortController();
    setShowsLoading(true);
    setShowsError(null);
    setShowsData(null);

    getNearbyShows(shouldUseZip ? trimmedZip : "", SHOWS_PAGE_LIMIT, {
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setShowsData(response);
        setShowsError(null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setShowsError(
          error.response?.data?.message || "Failed to load nearby shows",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setShowsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [locationMode, appliedZip]);

  const showGroups = useMemo(() => getShowGroups(showsData), [showsData]);
  const allTotal = getSafeCount(showsData?.total, showGroups.all.length);
  const groupTotals = {
    all: allTotal,
    library: getSafeCount(
      showsData?.counts?.matchedLibraryShows,
      showGroups.library.length,
    ),
    discover: getSafeCount(
      showsData?.counts?.matchedRecommendedShows,
      showGroups.discover.length,
    ),
  };
  const shows = showGroups[showFilter] || showGroups.all;
  const hasAnyShows = Object.values(showGroups).some(
    (group) => group.length > 0,
  );
  const locationLabel =
    showsData?.location?.label ||
    showsData?.location?.postalCode ||
    "your area";
  const pageSubtitle = showsLoading
    ? "Finding Ticketmaster events matched to your library and recommendations."
    : `Upcoming concerts around ${locationLabel}.`;

  const emptyMessage =
    showFilter === "library"
      ? `We could not find local Ticketmaster shows for artists from your library around ${locationLabel}.`
      : showFilter === "discover"
        ? `We could not find local Ticketmaster shows tied to your Discover recommendations around ${locationLabel}.`
        : `We could not find local Ticketmaster shows for artists from your library or Discover around ${locationLabel}.`;

  return (
    <div className="shows-page">
      <header className="shows-page__header">
        <div className="shows-page__title-row">
          <div className="shows-page__title-wrap">
            <h1 className="shows-page__title">Shows Near You</h1>
            <p className="shows-page__subtitle">{pageSubtitle}</p>
          </div>
          <NearbyLocationControl
            locationMode={locationMode}
            appliedZip={appliedZip}
            location={showsData?.location}
            onSelectYourLocation={() => {
              setLocationState((current) => ({
                ...current,
                locationMode: "ip",
              }));
              writeStoredLocationMode("ip");
            }}
            onStartCustomLocation={() => {
              setLocationState((current) => ({
                ...current,
                locationMode: "zip",
              }));
              writeStoredLocationMode("zip");
            }}
            onApplyZip={(sanitized) => {
              const nextZip = sanitized.trim();
              setLocationState({
                locationMode: "zip",
                appliedZip: nextZip,
              });
              writeStoredLocationMode("zip");
              writeStoredZip(nextZip);
            }}
          />
        </div>
      </header>

      {showsData?.configured === false ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <MapPin className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">
            Ticketmaster not configured
          </h2>
          <p className="search-empty-panel__message">
            Add a Ticketmaster Consumer Key in Settings to enable local show
            discovery.
          </p>
          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="btn btn-primary btn--bold btn-min-h shows-page__panel-action"
          >
            Open Settings
          </button>
        </div>
      ) : showsLoading ? (
        <div className="artist-loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      ) : showsError ? (
        <div className="artist-error-panel" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load nearby shows</h2>
          <p className="artist-error-copy">{showsError}</p>
        </div>
      ) : zipModeActive && !appliedZip.trim() ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <MapPin className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">
            Enter a ZIP or postal code
          </h2>
          <p className="search-empty-panel__message">
            Open the location menu above and enter a ZIP or postal code.
          </p>
        </div>
      ) : hasAnyShows ? (
        <section className="shows-page__content">
          <div className="shows-page__toolbar">
            <div
              className="artist-segmented shows-page__filters"
              role="group"
              aria-label="Show filters"
            >
              {SHOW_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setShowFilter(option.id)}
                  className={`artist-segmented-button${showFilter === option.id ? " is-active" : ""}`}
                  aria-pressed={showFilter === option.id}
                >
                  <span>{option.label}</span>
                  <span className="shows-page__filter-count">
                    {groupTotals[option.id] ?? 0}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {shows.length > 0 ? (
            <div className="shows-page__grid">
              {shows.map((show, index) => (
                <div
                  key={getShowKey(show, index)}
                  className="shows-page__grid-item"
                >
                  <ShowCard show={show} />
                </div>
              ))}
            </div>
          ) : (
            <div className="search-empty-panel shows-page__empty">
              <div className="search-empty-panel__icon" aria-hidden="true">
                <Music className="artist-icon-lg" />
              </div>
              <h2 className="search-empty-panel__title">
                No matches in this filter
              </h2>
              <p className="search-empty-panel__message">{emptyMessage}</p>
            </div>
          )}
        </section>
      ) : (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">
            No upcoming nearby matches
          </h2>
          <p className="search-empty-panel__message">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}

export default ShowsPage;
