import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Clock,
  CheckCircle2,
  AlertCircle,
  X,
  Music,
  RefreshCw,
} from "lucide-react";
import {
  getRequests,
  deleteRequest,
  getDownloadStatus,
  triggerAlbumSearch,
} from "../utils/api";
import ArtistImage from "../components/ArtistImage";
import { useToast } from "../contexts/ToastContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function RequestStatusBadge({ request, downloadStatuses }) {
  const albumStatus = request.albumId
    ? downloadStatuses[String(request.albumId)]
    : null;
  const artistDownloadStatuses = Object.values(downloadStatuses).filter(
    (status) =>
      status &&
      (status.status === "adding" ||
        status.status === "searching" ||
        status.status === "downloading" ||
        status.status === "moving"),
  );
  const hasActiveDownloads = artistDownloadStatuses.length > 0;

  if (albumStatus?.status === "adding") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        Adding...
      </span>
    );
  }

  if (albumStatus?.status === "downloading") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        Downloading...
      </span>
    );
  }

  if (albumStatus?.status === "searching") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        Searching...
      </span>
    );
  }

  if (albumStatus?.status === "moving") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        Moving files...
      </span>
    );
  }

  if (albumStatus?.status === "processing") {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        Processing
      </span>
    );
  }

  if (albumStatus?.status === "added") {
    return (
      <span className="requests-page__badge requests-page__badge--success">
        <CheckCircle2 className="artist-icon-xs" />
        Completed
      </span>
    );
  }

  if (request.status === "available") {
    return (
      <span className="requests-page__badge requests-page__badge--success">
        <CheckCircle2 className="artist-icon-xs" />
        Available
      </span>
    );
  }

  if (albumStatus?.status === "failed" || request.status === "failed") {
    return (
      <span className="requests-page__badge requests-page__badge--failed">
        <AlertCircle className="artist-icon-xs" />
        Failed
      </span>
    );
  }

  if (request.status === "processing" || hasActiveDownloads) {
    return (
      <span className="requests-page__badge requests-page__badge--active">
        <Loader className="artist-icon-xs animate-spin" />
        {hasActiveDownloads ? "Downloading..." : "Processing"}
      </span>
    );
  }

  return (
    <span className="requests-page__badge requests-page__badge--pending">
      Requested
    </span>
  );
}

function RequestsPage() {
  useDocumentTitle("Requests");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadStatuses, setDownloadStatuses] = useState({});
  const [reSearchingAlbumIds, setReSearchingAlbumIds] = useState({});
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const activeAlbumIdsRef = useRef([]);
  const lastDownloadWsAtRef = useRef(0);
  const handleDownloadStatusMessage = useCallback((msg) => {
    if (msg?.type !== "download_statuses") return;
    lastDownloadWsAtRef.current = Date.now();
    const activeIds = activeAlbumIdsRef.current;
    if (!activeIds.length) return;
    const incoming = msg.statuses || {};
    const next = {};
    for (const id of activeIds) {
      if (incoming[id]) next[id] = incoming[id];
    }
    setDownloadStatuses((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) return next;
      for (const key of nextKeys) {
        const prevStatus = prev[key];
        const nextStatus = next[key];
        if (
          prevStatus?.status !== nextStatus?.status ||
          prevStatus?.progress !== nextStatus?.progress ||
          prevStatus?.updatedAt !== nextStatus?.updatedAt
        ) {
          return next;
        }
      }
      return prev;
    });
  }, []);

  useWebSocketChannel("downloads", handleDownloadStatusMessage);

  const activeAlbumIds = useMemo(() => {
    return requests
      .filter(
        (request) =>
          request.albumId &&
          (request.inQueue ||
            (request.status &&
              request.status !== "available" &&
              request.status !== "failed")),
      )
      .map((request) => String(request.albumId));
  }, [requests]);

  const activeAlbumIdsKey = useMemo(() => {
    if (!activeAlbumIds.length) return "";
    return [...activeAlbumIds].sort().join(",");
  }, [activeAlbumIds]);

  const fetchRequests = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const data = await getRequests();
      setRequests(data);
      setError(null);
    } catch {
      setError("Failed to load requests history.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  const fetchActiveDownloadStatus = useCallback(async (albumIds) => {
    const hasExplicitAlbumIds = Array.isArray(albumIds);
    const ids = Array.isArray(albumIds)
      ? albumIds
      : activeAlbumIdsRef.current;
    if (!ids.length) {
      setDownloadStatuses({});
      return;
    }
    try {
      const statuses = await getDownloadStatus(ids);
      setDownloadStatuses((prev) => {
        if (hasExplicitAlbumIds) {
          return {
            ...prev,
            ...(statuses || {}),
          };
        }
        return statuses || {};
      });
    } catch {}
  }, []);

  useEffect(() => {
    activeAlbumIdsRef.current = activeAlbumIds;
  }, [activeAlbumIds]);

  useEffect(() => {
    fetchRequests();
    const initialRefreshTimeout = setTimeout(() => {
      fetchRequests({ silent: true });
    }, 2500);

    const handleFocus = () => {
      fetchRequests({ silent: true });
      fetchActiveDownloadStatus();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchRequests({ silent: true });
        fetchActiveDownloadStatus();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearTimeout(initialRefreshTimeout);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRequests, fetchActiveDownloadStatus]);

  useEffect(() => {
    const albumIds = activeAlbumIdsKey ? activeAlbumIdsKey.split(",") : [];
    if (!albumIds.length) {
      setDownloadStatuses({});
      return;
    }

    let cancelled = false;
    const pollDownloadStatus = async () => {
      if (Date.now() - lastDownloadWsAtRef.current < 20000) {
        return;
      }
      try {
        const statuses = await getDownloadStatus(albumIds);
        if (!cancelled) {
          setDownloadStatuses(statuses || {});
        }
      } catch {}
    };

    pollDownloadStatus();
    const interval = setInterval(pollDownloadStatus, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeAlbumIdsKey]);

  useEffect(() => {
    const hasActive = requests.some(
      (request) =>
        request.inQueue ||
        (request.status && request.status !== "available" && request.status !== "failed"),
    );
    const intervalMs = hasActive ? 15000 : 60000;
    const interval = setInterval(() => {
      fetchRequests({ silent: true });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [requests, fetchRequests]);

  const handleStopDownload = async (request) => {
    if (!request.inQueue || !request.albumId) return;
    try {
      await deleteRequest(request.albumId);
      setRequests((prev) =>
        prev.filter((r) => String(r.albumId) !== String(request.albumId)),
      );
    } catch {
      showError("Failed to stop download");
    }
  };

  const handleReSearchRequest = async (request) => {
    if (!request?.albumId) return;
    const albumId = String(request.albumId);
    setReSearchingAlbumIds((prev) => ({
      ...prev,
      [albumId]: true,
    }));
    try {
      setDownloadStatuses((prev) => ({
        ...prev,
        [albumId]: { status: "searching" },
      }));
      await triggerAlbumSearch(request.albumId);
      showSuccess("Search triggered for album");
      fetchActiveDownloadStatus([albumId]);
    } catch (err) {
      showError(
        `Failed to re-search album: ${
          err.response?.data?.message || err.message
        }`,
      );
    } finally {
      setReSearchingAlbumIds((prev) => {
        const next = { ...prev };
        delete next[albumId];
        return next;
      });
    }
  };

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

  if (loading) {
    return (
      <div className="requests-page">
        <header className="requests-page__header">
          <h1 className="requests-page__title">Requests</h1>
          <p className="requests-page__subtitle">
            Track your album requests and their availability
          </p>
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
        <h1 className="requests-page__title">Requests</h1>
        <p className="requests-page__subtitle">
          Track your album requests and their availability
        </p>
      </header>

      {error && (
        <div className="artist-error-panel requests-page__error" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Unable to load requests</h2>
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

      {!error && requests.length === 0 ? (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">No Requests Found</h2>
          <p className="search-empty-panel__message">
            You haven&apos;t requested any albums yet.
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="btn btn-primary btn--bold btn-min-h requests-page__empty-action"
          >
            Start Discovering
          </button>
        </div>
      ) : (
        !error && (
          <div className="requests-page__list">
            {requests.map((request) => {
              const isAlbum = request.type === "album";
              const displayName = isAlbum ? request.albumName : request.name;
              const artistName = isAlbum ? request.artistName : null;
              const artistMbid = isAlbum ? request.artistMbid : request.mbid;
              const hasValidMbid =
                artistMbid && artistMbid !== "null" && artistMbid !== "undefined";
              const albumStatus = request.albumId
                ? downloadStatuses[String(request.albumId)]
                : null;
              const statusValue = albumStatus?.status;
              const isFailed =
                statusValue === "failed" ||
                (!statusValue && request.status === "failed");
              const isReSearching =
                request.albumId &&
                !!reSearchingAlbumIds[String(request.albumId)];

              return (
                <article
                  key={request.id || request.mbid}
                  className="requests-page__row"
                >
                  <div
                    className={`artist-media-cell artist-list-cover requests-page__cover${hasValidMbid ? " is-clickable" : " is-disabled"}`}
                    onClick={() =>
                      navigateToArtist(
                        request,
                        isAlbum,
                        artistMbid,
                        artistName,
                        displayName,
                      )
                    }
                  >
                    <ArtistImage
                      src={request.image}
                      mbid={artistMbid}
                      artistName={isAlbum ? artistName : displayName}
                      alt={displayName}
                      className="artist-image-fill"
                    />
                  </div>

                  <div className="requests-page__body">
                    <div className="requests-page__details">
                      <h3
                        className={`requests-page__item-title${hasValidMbid ? " is-clickable" : " is-disabled"}`}
                        onClick={() =>
                          navigateToArtist(
                            request,
                            isAlbum,
                            artistMbid,
                            artistName,
                            displayName,
                          )
                        }
                      >
                        {displayName}
                      </h3>

                      <div className="requests-page__meta">
                        {isAlbum && artistName && (
                          <span className="requests-page__meta-line">
                            <Music className="artist-icon-xs" />
                            <span className="artist-truncate">{artistName}</span>
                          </span>
                        )}
                        <span className="requests-page__meta-line">
                          <Clock className="artist-icon-xs" />
                          <span className="artist-truncate">
                            {new Date(request.requestedAt).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </span>
                        </span>
                      </div>
                    </div>

                    <div className="requests-page__status">
                      <RequestStatusBadge
                        request={request}
                        downloadStatuses={downloadStatuses}
                      />
                      {(isFailed || request.inQueue) && request.albumId && (
                        <div className="requests-page__actions">
                          {isFailed && (
                            <button
                              type="button"
                              onClick={() => handleReSearchRequest(request)}
                              className="btn btn-surface btn-icon-square requests-page__action"
                              title="Re-search"
                              aria-label="Re-search"
                              disabled={isReSearching}
                            >
                              {isReSearching ? (
                                <Loader className="artist-icon-xs animate-spin" />
                              ) : (
                                <RefreshCw className="artist-icon-xs" />
                              )}
                            </button>
                          )}
                          {request.inQueue && (
                            <button
                              type="button"
                              onClick={() => handleStopDownload(request)}
                              className="btn btn-surface btn-icon-square requests-page__action btn--danger-text"
                              title="Stop download"
                              aria-label="Stop download"
                            >
                              <X className="artist-icon-xs" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

export default RequestsPage;
