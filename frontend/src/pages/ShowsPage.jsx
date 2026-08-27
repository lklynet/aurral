import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Music, MapPin, AlertCircle } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import { PageSectionMobileNav } from "../components/PageSectionMobileNav";
import { useNearbyShows } from "../hooks/useNearbyShows";
import {
  DEFAULT_SHOWS_FILTER,
  normalizeShowsFilter,
  SHOWS_FILTERS,
} from "../navigation/showsNavConfig";

const SHOWS_PAGE_LIMIT = 60;

const getShowGroups = (showsData) => ({
  all: Array.isArray(showsData?.shows) ? showsData.shows : [],
  library: Array.isArray(showsData?.libraryShows) ? showsData.libraryShows : [],
  discover: Array.isArray(showsData?.recommendedShows) ? showsData.recommendedShows : [],
});

const getShowKey = (show, index) =>
  [show?.id || `show-${index}`, show?.artistName, show?.sourceType || "show"]
    .filter(Boolean)
    .join("-");

function ShowsPage() {
  const navigate = useNavigate();
  const { filter: filterParam } = useParams();
  const showFilter = normalizeShowsFilter(filterParam);
  const shouldRedirect = filterParam && normalizeShowsFilter(filterParam) !== filterParam;

  useDocumentTitle(
    showFilter === "all"
      ? "Shows"
      : `${SHOWS_FILTERS.find((entry) => entry.id === showFilter)?.label || "Shows"} - Shows`,
  );

  const {
    data: showsData,
    loading: showsLoading,
    error: showsError,
    locationMode,
    appliedZip,
    appliedCountry,
    setLocationMode,
    setAppliedZip,
    locationLabel,
  } = useNearbyShows({ limit: SHOWS_PAGE_LIMIT });

  const zipModeActive = locationMode === "zip";
  const showGroups = getShowGroups(showsData);
  const shows = showGroups[showFilter] || showGroups.all;
  const hasAnyShows = Object.values(showGroups).some((group) => group.length > 0);
  const emptyMessage =
    showFilter === "library"
      ? `We could not find local Ticketmaster shows for artists from your library around ${locationLabel}.`
      : showFilter === "discover"
        ? `We could not find local Ticketmaster shows tied to your Discover recommendations around ${locationLabel}.`
        : `We could not find local Ticketmaster shows for artists from your library or Discover around ${locationLabel}.`;

  if (!filterParam) {
    return <Navigate to={`/shows/${DEFAULT_SHOWS_FILTER}`} replace />;
  }

  if (shouldRedirect) {
    return <Navigate to={`/shows/${showFilter}`} replace />;
  }

  return (
    <div className="shows-page">
      <header className="shows-page__header">
        <div className="shows-page__title-row">
          <div className="shows-page__title-wrap">
            <h1 className="page-title">Shows Near You</h1>
          </div>
          <NearbyLocationControl
            locationMode={locationMode}
            appliedZip={appliedZip}
            appliedCountry={appliedCountry}
            location={showsData?.location}
            onSelectYourLocation={() => setLocationMode("ip")}
            onStartCustomLocation={() => setLocationMode("zip")}
            onApplyZip={setAppliedZip}
          />
        </div>
      </header>

      <PageSectionMobileNav
        basePath="/shows"
        sections={SHOWS_FILTERS}
        activeId={showFilter}
        label="Shows"
      />

      {showsData?.configured === false ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <MapPin className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">Ticketmaster not configured</h2>
          <p className="search-empty-panel__message">
            Add a Ticketmaster Consumer Key in Settings to enable local show discovery.
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
          <DotLoader size="2xl" label={null} />
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
          <h2 className="search-empty-panel__title">Enter a ZIP or postal code</h2>
          <p className="search-empty-panel__message">
            Open the location menu above and enter a ZIP or postal code.
          </p>
        </div>
      ) : hasAnyShows ? (
        <section className="shows-page__content">
          {shows.length > 0 ? (
            <div className="shows-page__grid">
              {shows.map((show, index) => (
                <div key={getShowKey(show, index)} className="shows-page__grid-item">
                  <ShowCard show={show} />
                </div>
              ))}
            </div>
          ) : (
            <div className="search-empty-panel shows-page__empty">
              <div className="search-empty-panel__icon" aria-hidden="true">
                <Music className="artist-icon-lg" />
              </div>
              <h2 className="search-empty-panel__title">No matches in this filter</h2>
              <p className="search-empty-panel__message">{emptyMessage}</p>
            </div>
          )}
        </section>
      ) : (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">No upcoming nearby matches</h2>
          <p className="search-empty-panel__message">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}

export default ShowsPage;
