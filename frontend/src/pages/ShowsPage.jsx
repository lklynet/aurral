import { useState, useEffect } from "react";
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

function ShowsPage() {
  useDocumentTitle("Shows");
  const navigate = useNavigate();
  const [showsData, setShowsData] = useState(null);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsError, setShowsError] = useState(null);
  const [showFilter, setShowFilter] = useState("all");
  const [locationMode, setLocationMode] = useState("ip");
  const [appliedZip, setAppliedZip] = useState("");
  const zipModeActive = locationMode === "zip";

  useEffect(() => {
    try {
      const storedMode = localStorage.getItem(NEARBY_MODE_KEY);
      const storedZip = localStorage.getItem(NEARBY_ZIP_KEY) || "";
      if (storedMode === "zip" || storedMode === "ip") {
        setLocationMode(storedMode);
      }
      setAppliedZip(storedZip);
    } catch {}
  }, []);

  useEffect(() => {
    const shouldUseZip = locationMode === "zip";
    if (shouldUseZip && !appliedZip.trim()) {
      setShowsData(null);
      setShowsError(null);
      setShowsLoading(false);
      return;
    }

    let cancelled = false;
    setShowsLoading(true);
    setShowsError(null);

    getNearbyShows(shouldUseZip ? appliedZip : "", SHOWS_PAGE_LIMIT)
      .then((response) => {
        if (cancelled) return;
        setShowsData(response);
        setShowsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setShowsError(
          error.response?.data?.message || "Failed to load nearby shows",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setShowsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locationMode, appliedZip]);

  const allShows = showsData?.shows || [];
  const libraryShows = showsData?.libraryShows || [];
  const discoverShows = showsData?.recommendedShows || [];
  const shows =
    showFilter === "library"
      ? libraryShows
      : showFilter === "discover"
        ? discoverShows
        : allShows;
  const locationLabel =
    showsData?.location?.label || showsData?.location?.postalCode || "your area";
  const pageSubtitle = showsLoading
    ? "Finding Ticketmaster events matched to your library and recommendations."
    : `Upcoming concerts around ${locationLabel}, matched to artists in your library and Discover.`;

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
              setLocationMode("ip");
              try {
                localStorage.setItem(NEARBY_MODE_KEY, "ip");
              } catch {}
            }}
            onStartCustomLocation={() => {
              setLocationMode("zip");
              try {
                localStorage.setItem(NEARBY_MODE_KEY, "zip");
              } catch {}
            }}
            onApplyZip={(sanitized) => {
              setAppliedZip(sanitized);
              setLocationMode("zip");
              try {
                localStorage.setItem(NEARBY_MODE_KEY, "zip");
                localStorage.setItem(NEARBY_ZIP_KEY, sanitized);
              } catch {}
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
      ) : shows.length > 0 ? (
        <section className="shows-page__content">
          <div className="shows-page__toolbar">
            <div className="shows-page__toolbar-copy">
              <p className="artist-count shows-page__result-count">
                Showing {shows.length}
                {showFilter === "all" && showsData?.total > shows.length
                  ? ` of ${showsData.total}`
                  : ""}{" "}
                upcoming matches
              </p>
              {showFilter === "all" && showsData?.total > shows.length && (
                <p className="shows-page__hint">
                  Refine the area to narrow the list
                </p>
              )}
            </div>
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
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="shows-page__grid">
            {shows.map((show) => (
              <div
                key={`${show.id}-${show.artistName}-${show.sourceType || show.matchType || "show"}`}
                className="shows-page__grid-item"
              >
                <ShowCard show={show} />
              </div>
            ))}
          </div>
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
