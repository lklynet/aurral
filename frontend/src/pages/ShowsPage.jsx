import { useState, useEffect, memo } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  Clock,
  MapPin,
  Pencil,
  Ticket,
} from "lucide-react";
import { getNearbyShows } from "../utils/api";

const NEARBY_MODE_KEY = "discoverNearbyMode";
const NEARBY_ZIP_KEY = "discoverNearbyZip";
const SHOWS_PAGE_LIMIT = 60;

const formatShowDate = (show) => {
  if (!show?.date && !show?.dateTime) return null;
  const raw = show.dateTime || show.date;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return show.date || null;
  }
  const dateLabel = parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (show.time) {
    return `${dateLabel} at ${show.time}`;
  }
  return dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

const ShowCard = memo(({ show }) => {
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);

  return (
    <article
      className="group flex flex-col overflow-hidden border border-white/10"
      style={{ backgroundColor: "#191820" }}
    >
      <div
        className="relative aspect-[16/9] overflow-hidden"
        style={{ backgroundColor: "#211f27" }}
      >
        {show.image ? (
          <img
            src={show.image}
            alt={show.eventName || show.artistName}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music className="w-10 h-10" style={{ color: "#c1c1c3" }} />
          </div>
        )}
        <div className="absolute left-3 top-3 flex gap-2">
          {Number.isFinite(show.distance) && (
            <span
              className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
              style={{ backgroundColor: "rgba(20,20,26,0.82)", color: "#fff" }}
            >
              {Math.round(show.distance)} mi
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.22em]" style={{ color: "#8a8a8f" }}>
            {show.artistName}
          </p>
          <h3 className="mt-1 text-lg font-semibold leading-tight" style={{ color: "#fff" }}>
            {show.eventName}
          </h3>
        </div>
        <div className="space-y-2 text-sm" style={{ color: "#c1c1c3" }}>
          {showDate && (
            <p className="flex items-center gap-2">
              <Clock className="w-4 h-4 shrink-0" />
              <span>{showDate}</span>
            </p>
          )}
          {showLocation && (
            <p className="flex items-start gap-2">
              <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{showLocation}</span>
            </p>
          )}
        </div>
        <div className="mt-auto pt-2">
          <a
            href={show.url || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors hover:opacity-90"
            style={{ backgroundColor: "#707e61", color: "#0b0b0c" }}
          >
            <Ticket className="w-4 h-4" />
            Tickets
          </a>
        </div>
      </div>
    </article>
  );
});

ShowCard.displayName = "ShowCard";

ShowCard.propTypes = {
  show: PropTypes.shape({
    id: PropTypes.string,
    artistName: PropTypes.string,
    eventName: PropTypes.string,
    image: PropTypes.string,
    url: PropTypes.string,
    date: PropTypes.string,
    time: PropTypes.string,
    dateTime: PropTypes.string,
    venueName: PropTypes.string,
    city: PropTypes.string,
    region: PropTypes.string,
    distance: PropTypes.number,
  }).isRequired,
};

function ShowsPage() {
  const navigate = useNavigate();
  const [showsData, setShowsData] = useState(null);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsError, setShowsError] = useState(null);
  const [locationMode, setLocationMode] = useState("ip");
  const [appliedZip, setAppliedZip] = useState("");
  const [showZipEditor, setShowZipEditor] = useState(false);
  const [zipDraft, setZipDraft] = useState("");

  useEffect(() => {
    try {
      const storedMode = localStorage.getItem(NEARBY_MODE_KEY);
      const storedZip = localStorage.getItem(NEARBY_ZIP_KEY) || "";
      if (storedMode === "zip" || storedMode === "ip") {
        setLocationMode(storedMode);
      }
      setAppliedZip(storedZip);
      setZipDraft(storedZip);
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

  const shows = showsData?.shows || [];
  const locationLabel =
    showsData?.location?.label || showsData?.location?.postalCode || "your area";
  const zipModeActive = locationMode === "zip";

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight" style={{ color: "#fff" }}>
            Shows Near You
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex p-1 border border-white/10" style={{ backgroundColor: "#17161d" }}>
            <button
              type="button"
              onClick={() => {
                setLocationMode("ip");
                setShowZipEditor(false);
                try {
                  localStorage.setItem(NEARBY_MODE_KEY, "ip");
                } catch {}
              }}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                backgroundColor: !zipModeActive ? "#707e61" : "transparent",
                color: !zipModeActive ? "#0b0b0c" : "#c1c1c3",
              }}
            >
              Your Area
            </button>
            <button
              type="button"
              onClick={() => {
                setLocationMode("zip");
                try {
                  localStorage.setItem(NEARBY_MODE_KEY, "zip");
                } catch {}
              }}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                backgroundColor: zipModeActive ? "#707e61" : "transparent",
                color: zipModeActive ? "#0b0b0c" : "#c1c1c3",
              }}
            >
              ZIP
            </button>
          </div>
          {zipModeActive && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setZipDraft(appliedZip);
                  setShowZipEditor((value) => !value);
                }}
                className="inline-flex items-center justify-center w-8 h-8 border border-white/10 transition-colors"
                style={{ backgroundColor: "#17161d", color: "#c1c1c3" }}
                aria-label="Edit ZIP"
                title="Edit ZIP"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {showZipEditor && (
                <div
                  className="absolute right-0 top-10 z-20 w-52 p-2 border border-white/10"
                  style={{ backgroundColor: "#17161d" }}
                >
                  <input
                    type="text"
                    value={zipDraft}
                    onChange={(event) => setZipDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const sanitized = zipDraft.trim();
                      if (!sanitized) return;
                      setAppliedZip(sanitized);
                      setLocationMode("zip");
                      setShowZipEditor(false);
                      try {
                        localStorage.setItem(NEARBY_MODE_KEY, "zip");
                        localStorage.setItem(NEARBY_ZIP_KEY, sanitized);
                      } catch {}
                    }}
                    className="input w-full mb-2"
                    placeholder="ZIP or postal code"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowZipEditor(false)}
                      className="px-2 py-1 text-xs border border-white/10"
                      style={{ color: "#c1c1c3" }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const sanitized = zipDraft.trim();
                        if (!sanitized) return;
                        setAppliedZip(sanitized);
                        setLocationMode("zip");
                        setShowZipEditor(false);
                        try {
                          localStorage.setItem(NEARBY_MODE_KEY, "zip");
                          localStorage.setItem(NEARBY_ZIP_KEY, sanitized);
                        } catch {}
                      }}
                      className="px-2 py-1 text-xs"
                      style={{
                        backgroundColor: "#707e61",
                        color: "#0b0b0c",
                        opacity: zipDraft.trim() ? 1 : 0.5,
                      }}
                      disabled={!zipDraft.trim()}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showsData?.configured === false ? (
        <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
          <h2 className="text-lg font-semibold" style={{ color: "#fff" }}>
            Ticketmaster not configured
          </h2>
          <p className="mt-2 text-sm max-w-2xl" style={{ color: "#c1c1c3" }}>
            Add a Ticketmaster Consumer Key in Settings to enable local show discovery.
          </p>
          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="btn btn-primary mt-4"
          >
            Open Settings
          </button>
        </div>
      ) : showsLoading ? (
        <div className="flex items-center justify-center py-24" style={{ backgroundColor: "#191820" }}>
          <Loader className="w-8 h-8 animate-spin" style={{ color: "#c1c1c3" }} />
        </div>
      ) : showsError ? (
        <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
          <h2 className="text-lg font-semibold" style={{ color: "#fff" }}>
            Unable to load nearby shows
          </h2>
          <p className="mt-2 text-sm" style={{ color: "#c1c1c3" }}>
            {showsError}
          </p>
        </div>
      ) : zipModeActive && !appliedZip.trim() ? (
        <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
          <h2 className="text-lg font-semibold" style={{ color: "#fff" }}>
            Enter a ZIP or postal code
          </h2>
          <p className="mt-2 text-sm" style={{ color: "#c1c1c3" }}>
            Use a postal code to browse library shows in another area.
          </p>
        </div>
      ) : shows.length > 0 ? (
        <div className="space-y-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <p className="text-sm" style={{ color: "#8a8a8f" }}>
              Showing {shows.length}
              {showsData?.total > shows.length ? ` of ${showsData.total}` : ""} upcoming
              matches around {locationLabel}
            </p>
            {showsData?.total > shows.length && (
              <p className="text-xs uppercase tracking-wide" style={{ color: "#8a8a8f" }}>
                Refine the area to narrow the list
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shows.map((show) => (
              <ShowCard key={`${show.id}-${show.artistName}`} show={show} />
            ))}
          </div>
        </div>
      ) : (
        <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
          <h2 className="text-lg font-semibold" style={{ color: "#fff" }}>
            No upcoming nearby matches
          </h2>
          <p className="mt-2 text-sm max-w-2xl" style={{ color: "#c1c1c3" }}>
            We could not find local Ticketmaster shows for artists from your library around {locationLabel}.
          </p>
        </div>
      )}
    </div>
  );
}

export default ShowsPage;
