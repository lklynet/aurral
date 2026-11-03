import { Navigate, useParams } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { SettingsLink } from "./Settings/settingsRoute";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Music, MapPin, AlertCircle } from "../components/icons";
import { SkeletonShowCard, SkeletonStatus } from "../components/Skeletons";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import { PageSectionMobileNav } from "../components/PageSectionMobileNav";
import { useNearbyShows } from "../hooks/useNearbyShows";
import {
  DEFAULT_SHOWS_FILTER,
  normalizeShowsFilter,
  SHOWS_FILTERS,
  type ShowsFilterId,
} from "../navigation/showsNavConfig";
import StatePanel from "../components/StatePanel";

const SHOWS_PAGE_LIMIT = 60;

type ShowSourceType = "library" | "recommended" | "trending";
type NearbyShow = { sourceTypes?: ShowSourceType[] };

const SHOW_FILTER_MATCHERS: Partial<
  Record<ShowsFilterId, (show: NearbyShow) => boolean | undefined>
> = {
  library: (show: NearbyShow) => show.sourceTypes?.includes("library"),
  discover: (show: NearbyShow) => show.sourceTypes?.some((sourceType) => sourceType !== "library"),
};

function ShowsPage() {
  const { hasPermission } = useAuth();
  const canManageServer = hasPermission("accessSettings");
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
  } = useNearbyShows();

  const zipModeActive = locationMode === "zip";
  const allShows = Array.isArray(showsData?.shows) ? showsData.shows : [];
  const matchesFilter = SHOW_FILTER_MATCHERS[showFilter];
  const shows = (matchesFilter ? allShows.filter(matchesFilter) : allShows).slice(
    0,
    SHOWS_PAGE_LIMIT,
  );
  const hasAnyShows = allShows.length > 0;
  const emptyMessage =
    showFilter === "library"
      ? `No shows for Library artists near ${locationLabel}.`
      : showFilter === "discover"
        ? `No shows for recommended artists near ${locationLabel}.`
        : `No shows for Library or recommended artists near ${locationLabel}.`;

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
            <h1 className="page-title">Shows near you</h1>
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
        <StatePanel
          icon={<MapPin className="artist-icon-lg" />}
          title="Ticketmaster not configured"
          message={
            canManageServer
              ? "Add a Ticketmaster key in Settings → Discovery to find nearby shows."
              : "An admin needs to add a Ticketmaster key to find nearby shows."
          }
        >
          {canManageServer ? (
            <SettingsLink to="discovery/ticketmaster" className="btn btn-primary">
              Open Settings
            </SettingsLink>
          ) : null}
        </StatePanel>
      ) : showsLoading ? (
        <SkeletonStatus label="Loading shows">
          <div className="shows-page__grid">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="shows-page__grid-item">
                <SkeletonShowCard index={index} />
              </div>
            ))}
          </div>
        </SkeletonStatus>
      ) : showsError ? (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load nearby shows"
          message={showsError}
        />
      ) : zipModeActive && !appliedZip.trim() ? (
        <StatePanel
          icon={<MapPin className="artist-icon-lg" />}
          title="Enter a ZIP or postal code"
          message="Enter a ZIP or postal code."
        />
      ) : hasAnyShows ? (
        <section className="shows-page__content">
          {shows.length > 0 ? (
            <div className="shows-page__grid">
              {shows.map((show) => (
                <div key={show.id} className="shows-page__grid-item">
                  <ShowCard show={show} />
                </div>
              ))}
            </div>
          ) : (
            <StatePanel
              icon={<Music className="artist-icon-lg" />}
              title="No matches in this filter"
              message={emptyMessage}
            />
          )}
        </section>
      ) : (
        <StatePanel
          icon={<Music className="artist-icon-lg" />}
          title="No upcoming nearby matches"
          message={emptyMessage}
        />
      )}
    </div>
  );
}

export default ShowsPage;
