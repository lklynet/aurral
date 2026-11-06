import { Navigate, useParams } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { SettingsLink } from "./Settings/settingsRoute";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Music, MapPin, AlertCircle } from "../components/icons";
import { SkeletonFeedPage } from "../components/Skeletons";
import NearbyLocationControl from "../components/NearbyLocationControl";
import RouteLink from "../components/RouteLink";
import { DiscoverRail } from "../components/DiscoverRail";
import { ShowFeedTile, ShowLead } from "../components/DiscoverFeed";
import { useNearbyShows } from "../hooks/useNearbyShows";
import { useCollectionTint } from "../components/CollectionHeader";
import {
  DEFAULT_SHOWS_FILTER,
  normalizeShowsFilter,
  SHOWS_FILTERS,
  type ShowsFilterId,
} from "../navigation/showsNavConfig";
import StatePanel from "../components/StatePanel";
import { splitFeed } from "../utils/feedSections.ts";
import { getShowDay, type NearbyShow } from "../utils/shows.ts";

const SHOWS_PAGE_LIMIT = 60;

type ShowSourceType = "library" | "recommended" | "trending";
type FilterableShow = { sourceTypes?: ShowSourceType[] };

const SHOW_FILTER_MATCHERS: Partial<
  Record<ShowsFilterId, (show: FilterableShow) => boolean | undefined>
> = {
  library: (show) => show.sourceTypes?.includes("library"),
  discover: (show) => show.sourceTypes?.some((sourceType) => sourceType !== "library"),
};

const showMonth = (show: NearbyShow) =>
  getShowDay(show)?.toLocaleDateString(undefined, { month: "long" }) ?? "Date to be announced";

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
  const { lead, shelf, groups } = splitFeed(shows, showMonth);
  const tint = useCollectionTint(lead?.image);
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

  const configured = showsData?.configured !== false;

  return (
    <div className="feed-page shows-page" style={tint ? { "--collection-tint": tint } : undefined}>
      <header className="feed-page__header">
        <div className="feed-page__title-row">
          <h1 className="page-title">Shows</h1>
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
        {configured ? (
          <nav className="artist-tabs shows-page__filters" aria-label="Show filters">
            {SHOWS_FILTERS.map((entry) => (
              <RouteLink
                key={entry.id}
                to={`/shows/${entry.id}`}
                className={`artist-tab${entry.id === showFilter ? " is-active" : ""}`}
                aria-current={entry.id === showFilter ? "page" : undefined}
              >
                {entry.label}
              </RouteLink>
            ))}
          </nav>
        ) : null}
      </header>

      {!configured ? (
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
        <SkeletonFeedPage label="Loading shows" />
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
      ) : lead ? (
        <section className="feed-page__content">
          <ShowLead show={lead} />
          {shelf.length > 0 ? (
            <DiscoverRail title="Coming up">
              {shelf.map((show) => (
                <ShowFeedTile key={show.id} show={show} feedStyle="square" />
              ))}
            </DiscoverRail>
          ) : null}
          {groups.map((group) => (
            <section key={group.label} className="feed-page__group">
              <h2 className="artist-section-title--discover">{group.label}</h2>
              <div className="feed-page__list">
                {group.items.map((show) => (
                  <ShowFeedTile key={show.id} show={show} feedStyle="list" />
                ))}
              </div>
            </section>
          ))}
        </section>
      ) : (
        <StatePanel
          icon={<Music className="artist-icon-lg" />}
          title={hasAnyShows ? "No matches in this filter" : "No upcoming nearby matches"}
          message={emptyMessage}
        />
      )}
    </div>
  );
}

export default ShowsPage;
