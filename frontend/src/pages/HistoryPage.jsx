import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Clock,
  CheckCircle2,
  AlertCircle,
  Music,
  RotateCcw,
} from "lucide-react";
import { getRequests, triggerAlbumSearch } from "../utils/api";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { TAG_COLORS } from "./ArtistDetails/constants";

const HISTORY_SOURCE_COLORS = {
  lidarr: TAG_COLORS[10],
  slskd: TAG_COLORS[0],
  aurral: TAG_COLORS[12],
};

const HISTORY_TABS = [
  { value: "all", label: "All" },
  { value: "lidarr", label: "Lidarr", source: "lidarr" },
  { value: "slskd", label: "slskd", source: "slskd" },
  { value: "aurral", label: "Aurral", source: "aurral" },
];

const HISTORY_PAGE_SIZE = 25;

const getHistorySource = (request) => {
  if (request.source === "slskd") return "slskd";
  if (request.source === "aurral") return "aurral";
  if (request.source === "lidarr") return "lidarr";
  if (request.type === "album" || request.albumId) return "lidarr";
  return "aurral";
};

const matchesHistoryTab = (request, tab) => {
  if (tab === "all") return true;
  return getHistorySource(request) === tab;
};

const formatTimelineTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatDateGroupLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
};

const groupRequestsByDate = (requests) => {
  const groups = [];
  let currentLabel = null;
  for (const request of requests) {
    const label = formatDateGroupLabel(request.requestedAt);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ type: "date", label, key: `date-${label}` });
    }
    groups.push({ type: "item", request, key: request.id || request.mbid });
  }
  return groups;
};

const EMPTY_STATE_COPY = {
  all: {
    title: "No requests yet",
    message:
      "A chronological log of album requests, track downloads, and other activity will appear here.",
  },
  lidarr: {
    title: "No Lidarr requests",
    message: "Album requests from Lidarr will appear here.",
  },
  slskd: {
    title: "No slskd requests",
    message: "Track searches and downloads from slskd will appear here.",
  },
  aurral: {
    title: "No Aurral activity",
    message: "Playlist updates, discovery refreshes, and other work will appear here.",
  },
};

function RequestStatusBadge({ request }) {
  if (request.status === "completed" || request.status === "available") {
    return (
      <span className="requests-page__badge requests-page__badge--success">
        <CheckCircle2 className="artist-icon-xs" />
        {request.statusLabel || "Done"}
      </span>
    );
  }

  if (request.status === "failed") {
    return (
      <span className="requests-page__badge requests-page__badge--failed">
        <AlertCircle className="artist-icon-xs" />
        {request.statusLabel || "Failed"}
      </span>
    );
  }

  if (request.status === "processing" || request.status === "pending") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        {request.statusLabel || "In progress"}
      </span>
    );
  }

  return (
    <span className="requests-page__badge requests-page__badge--pending">
      <Clock className="artist-icon-xs" />
      {request.statusLabel || "Requested"}
    </span>
  );
}

function HistoryPage() {
  useDocumentTitle("History");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("all");
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const [reSearchingAlbumIds, setReSearchingAlbumIds] = useState({});
  const navigate = useNavigate();

  const filteredRequests = useMemo(
    () => requests.filter((request) => matchesHistoryTab(request, activeTab)),
    [requests, activeTab],
  );

  const sortedRequests = useMemo(
    () =>
      [...filteredRequests].sort(
        (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt),
      ),
    [filteredRequests],
  );

  const visibleRequests = useMemo(
    () => sortedRequests.slice(0, visibleCount),
    [sortedRequests, visibleCount],
  );

  const hasMoreHistory = visibleCount < sortedRequests.length;

  const timelineGroups = useMemo(
    () => groupRequestsByDate(visibleRequests),
    [visibleRequests],
  );

  useEffect(() => {
    setVisibleCount(HISTORY_PAGE_SIZE);
  }, [activeTab]);

  const fetchRequests = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const data = await getRequests();
      setRequests(data);
      setError(null);
    } catch {
      setError("Failed to load history.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchRequests();
    const initialRefreshTimeout = setTimeout(() => {
      fetchRequests({ silent: true });
    }, 2000);

    const handleFocus = () => {
      fetchRequests({ silent: true });
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchRequests({ silent: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearTimeout(initialRefreshTimeout);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRequests]);

  useEffect(() => {
    const hasOpen = requests.some(
      (request) =>
        request.status === "processing" || request.status === "pending",
    );
    const intervalMs = hasOpen ? 15000 : 60000;
    const interval = setInterval(() => {
      fetchRequests({ silent: true });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [requests, fetchRequests]);

  const navigateToArtist = (request, isAlbum, artistMbid, artistName, displayName) => {
    if (!artistMbid || artistMbid === "null" || artistMbid === "undefined") {
      return;
    }
    navigate(isAlbum ? `/artist/${artistMbid}` : `/artist/${request.mbid}`, {
      state: {
        artistName: isAlbum ? artistName : displayName,
      },
    });
  };

  const handleReSearchAlbum = async (request) => {
    const albumId = request.albumId;
    if (!albumId || reSearchingAlbumIds[albumId]) return;
    setReSearchingAlbumIds((prev) => ({ ...prev, [albumId]: true }));
    try {
      await triggerAlbumSearch(albumId);
      setRequests((prev) =>
        prev.map((item) =>
          String(item.albumId) === String(albumId)
            ? {
                ...item,
                status: "processing",
                statusLabel: "Searching",
                title: item.albumName
                  ? `Searching Lidarr for ${item.albumName}`
                  : item.title?.replace(/^No results for /, "Searching Lidarr for ") ||
                    item.title,
                canReSearch: false,
              }
            : item,
        ),
      );
    } catch {
      setError("Failed to trigger album search.");
    } finally {
      setReSearchingAlbumIds((prev) => {
        const next = { ...prev };
        delete next[albumId];
        return next;
      });
    }
  };

  const handleRowNavigate = (request, {
    isSlskd,
    isAurral,
    isAlbum,
    artistMbid,
    artistName,
    displayName,
  }) => {
    if (isSlskd && request.playlistId) {
      navigate(`/playlists?selected=${encodeURIComponent(request.playlistId)}`);
      return;
    }
    if (request.href && (isAurral || request.type === "activity")) {
      navigate(request.href);
      return;
    }
    navigateToArtist(request, isAlbum, artistMbid, artistName, displayName);
  };

  const renderRequestRow = (request, rowIndex = 0) => {
    const isSlskd = request.source === "slskd" || request.kind === "track_download";
    const isAurral = request.source === "aurral" && !isSlskd;
    const isActivity = request.type === "activity";
    const isAlbum = request.type === "album";
    const usesTitleSubtitle = isSlskd || isAurral || isActivity;
    const displayName = usesTitleSubtitle
      ? request.title
      : isAlbum
        ? request.albumName
        : request.name;
    const artistName = isAlbum ? request.artistName : null;
    const metaLine = usesTitleSubtitle
      ? request.subtitle || null
      : artistName;
    const artistMbid = isAlbum ? request.artistMbid : request.mbid;
    const canNavigate =
      (isSlskd && request.playlistId) ||
      ((isAurral || isActivity) && request.href) ||
      (artistMbid &&
        artistMbid !== "null" &&
        artistMbid !== "undefined");
    const historySource = getHistorySource(request);
    const sourceColor = HISTORY_SOURCE_COLORS[historySource];
    const timelineTime = formatTimelineTime(request.requestedAt);
    const canReSearch =
      request.canReSearch === true &&
      request.albumId &&
      !reSearchingAlbumIds[request.albumId];
    const isReSearching = Boolean(
      request.albumId && reSearchingAlbumIds[request.albumId],
    );
    const displayRequest =
      isReSearching && request.status === "failed"
        ? {
            ...request,
            status: "processing",
            statusLabel: "Searching",
          }
        : request;

    return (
      <article
        key={request.id || request.mbid}
        className={`requests-page__row requests-page__row--${historySource}${rowIndex % 2 === 1 ? " requests-page__row--alt" : ""}${canNavigate ? " is-clickable" : ""}`}
        style={{ "--history-source-color": sourceColor }}
        onClick={() => {
          if (!canNavigate) return;
          handleRowNavigate(request, {
            isSlskd,
            isAurral,
            isAlbum,
            artistMbid,
            artistName,
            displayName,
          });
        }}
      >
        <div className="requests-page__details">
          <h3 className="requests-page__item-title" title={displayName}>
            {displayName}
          </h3>
          {(timelineTime || metaLine) && (
            <div className="requests-page__meta">
              {timelineTime && (
                <time
                  className="requests-page__meta-time"
                  dateTime={request.requestedAt}
                >
                  {timelineTime}
                </time>
              )}
              {timelineTime && metaLine && (
                <span className="requests-page__meta-separator" aria-hidden="true">
                  ·
                </span>
              )}
              {metaLine && (
                <span className="artist-truncate">{metaLine}</span>
              )}
            </div>
          )}
        </div>

        <div
          className="requests-page__status"
          onClick={(event) => event.stopPropagation()}
        >
          <RequestStatusBadge request={displayRequest} />
          {canReSearch && (
            <div className="requests-page__actions">
              <button
                type="button"
                className="btn btn-secondary btn--icon requests-page__action"
                aria-label={`Re-search ${request.albumName || displayName}`}
                title="Re-search"
                onClick={() => handleReSearchAlbum(request)}
              >
                <RotateCcw className="artist-icon-xs" />
              </button>
            </div>
          )}
        </div>
      </article>
    );
  };

  const emptyState = EMPTY_STATE_COPY[activeTab] || EMPTY_STATE_COPY.all;

  if (loading) {
    return (
      <div className="requests-page">
        <header className="requests-page__header">
          <h1 className="requests-page__title">History</h1>
        </header>
        <div className="artist-loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="requests-page">
      <header className="requests-page__header">
        <h1 className="requests-page__title">History</h1>
        <p className="requests-page__subtitle requests-page__subtitle--desktop">
          A chronological log of requests and activity
        </p>
      </header>

      <div className="requests-page__toolbar">
        <div
          className="artist-tabs requests-page__tabs"
          role="tablist"
          aria-label="Filter history by source"
        >
          {HISTORY_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`artist-tab${tab.source ? " requests-page__tab--source" : ""}${activeTab === tab.value ? " is-active" : ""}`}
              style={
                tab.source
                  ? {
                      "--history-source-color":
                        HISTORY_SOURCE_COLORS[tab.source],
                    }
                  : undefined
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="artist-error-panel requests-page__error" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load history</h2>
          <p className="artist-error-copy">{error}</p>
          <button
            type="button"
            onClick={() => fetchRequests()}
            className="btn btn-secondary btn--bold btn-min-h requests-page__retry-button"
          >
            Try Again
          </button>
        </div>
      )}

      {!error && filteredRequests.length === 0 ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">{emptyState.title}</h2>
          <p className="search-empty-panel__message">{emptyState.message}</p>
          {activeTab === "all" && (
            <button
              type="button"
              onClick={() => navigate("/")}
              className="btn btn-primary btn--bold btn-min-h requests-page__empty-action"
            >
              Start Discovering
            </button>
          )}
        </div>
      ) : (
        !error && (
          <div className="requests-page__list">
            {(() => {
              let rowIndex = 0;
              return timelineGroups.map((entry) => {
                if (entry.type === "date") {
                  return (
                    <div
                      key={entry.key}
                      className="requests-page__date-group"
                    >
                      {entry.label}
                    </div>
                  );
                }
                const row = renderRequestRow(entry.request, rowIndex);
                rowIndex += 1;
                return row;
              });
            })()}
            {hasMoreHistory && (
              <div className="requests-page__load-more">
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((count) => count + HISTORY_PAGE_SIZE)
                  }
                  className="btn btn-secondary btn--bold btn-min-h"
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

export default HistoryPage;
