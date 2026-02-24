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

function RequestsPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadStatuses, setDownloadStatuses] = useState({});
  const [reSearchingAlbumId, setReSearchingAlbumId] = useState(null);
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const activeAlbumIdsRef = useRef([]);

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
    const ids = Array.isArray(albumIds)
      ? albumIds
      : activeAlbumIdsRef.current;
    if (!ids.length) {
      setDownloadStatuses({});
      return;
    }
    try {
      const statuses = await getDownloadStatus(ids);
      setDownloadStatuses(statuses || {});
    } catch {}
  }, []);

  useEffect(() => {
    activeAlbumIdsRef.current = activeAlbumIds;
  }, [activeAlbumIds]);

  useEffect(() => {
    fetchRequests();

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
        prev.filter((r) => String(r.albumId) !== String(request.albumId))
      );
    } catch {
      showError("Failed to stop download");
    }
  };

  const handleReSearchRequest = async (request) => {
    if (!request?.albumId) return;
    const albumId = String(request.albumId);
    setReSearchingAlbumId(albumId);
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
      setReSearchingAlbumId(null);
    }
  };

  const getStatusBadge = (request) => {
    const albumStatus = request.albumId
      ? downloadStatuses[String(request.albumId)]
      : null;
    const artistDownloadStatuses = Object.values(downloadStatuses).filter(
      (status) => {
        return (
          status &&
          (status.status === "adding" ||
            status.status === "searching" ||
            status.status === "downloading" ||
            status.status === "moving")
        );
      }
    );

    const hasActiveDownloads = artistDownloadStatuses.length > 0;

    if (albumStatus?.status === "downloading") {
      return (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded"
          style={{ backgroundColor: "#211f27", color: "#c1c1c3" }}
        >
          <Loader className="w-3 h-3 animate-spin" />
          Downloading...
        </span>
      );
    }

    if (albumStatus?.status === "searching") {
      return (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded"
          style={{ backgroundColor: "#211f27", color: "#c1c1c3" }}
        >
          <Loader className="w-3 h-3 animate-spin" />
          Searching...
        </span>
      );
    }

    if (albumStatus?.status === "processing") {
      return (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded"
          style={{ backgroundColor: "#211f27", color: "#c1c1c3" }}
        >
          <Loader className="w-3 h-3 animate-spin" />
          Processing
        </span>
      );
    }

    if (request.status === "available") {
      return (
        <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-green-500/20 text-green-400 rounded">
          <CheckCircle2 className="w-3 h-3" />
          Available
        </span>
      );
    }

    if (albumStatus?.status === "failed" || request.status === "failed") {
      return (
        <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-red-500/20 text-red-400 rounded">
          <AlertCircle className="w-3 h-3" />
          Failed
        </span>
      );
    }

    if (request.status === "processing" || hasActiveDownloads) {
      return (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded"
          style={{ backgroundColor: "#211f27", color: "#c1c1c3" }}
        >
          <Loader className="w-3 h-3 animate-spin" />
          {hasActiveDownloads ? "Downloading..." : "Processing"}
        </span>
      );
    }

    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-yellow-500/20 text-yellow-400 rounded">
        Requested
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <Loader
          className="w-12 h-12 animate-spin mb-4"
          style={{ color: "#c1c1c3" }}
        />
        <h2 className="text-xl font-semibold" style={{ color: "#fff" }}>
          Loading your requests...
        </h2>
      </div>
    );
  }

  return (
    <div className="animate-fade-in pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-4">
          <div>
            <h1
              className="text-2xl font-bold flex items-center"
              style={{ color: "#fff" }}
            >
              Requests
            </h1>
            <p className="text-sm" style={{ color: "#c1c1c3" }}>
              Track your album requests and their availability
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/20 ">
          <AlertCircle className="w-5 h-5 text-red-400" />
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="card text-center py-20">
          <Music
            className="w-16 h-16 mx-auto mb-4"
            style={{ color: "#c1c1c3" }}
          />
          <h3 className="text-xl font-semibold mb-2" style={{ color: "#fff" }}>
            No Requests Found
          </h3>
          <p className="mb-6" style={{ color: "#c1c1c3" }}>
            You haven&apos;t requested any albums yet.
          </p>
          <button onClick={() => navigate("/")} className="btn btn-primary">
            Start Discovering
          </button>
        </div>
      ) : (
        <div className="grid gap-2">
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
            const isFailed =
              albumStatus?.status === "failed" || request.status === "failed";
            const isReSearching =
              request.albumId &&
              String(request.albumId) === reSearchingAlbumId;

            return (
              <div
                key={request.id || request.mbid}
                className="card group hover:shadow-md transition-all relative p-3 overflow-hidden"
              >
                {request.inQueue && request.albumId && (
                  <button
                    onClick={() => handleStopDownload(request)}
                    className="absolute top-1.5 right-1.5 p-1.5 hover:text-red-400 hover:bg-red-500/20 transition-all z-10 rounded"
                    style={{ color: "#fff" }}
                    title="Stop download"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center min-w-0">
                  <div
                    className={`w-16 h-16 flex-shrink-0 overflow-hidden rounded ${
                      hasValidMbid
                        ? "cursor-pointer"
                        : "cursor-not-allowed opacity-50"
                    }`}
                    style={{ backgroundColor: "#211f27" }}
                    onClick={() => {
                      if (hasValidMbid) {
                        navigate(
                          isAlbum
                            ? `/artist/${artistMbid}`
                            : `/artist/${request.mbid}`,
                          {
                            state: {
                              artistName: isAlbum ? artistName : displayName,
                            },
                          }
                        );
                      }
                    }}
                  >
                    <ArtistImage
                      src={request.image}
                      mbid={artistMbid}
                      artistName={isAlbum ? artistName : displayName}
                      alt={displayName}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  </div>

                  <div className="flex-1 text-left min-w-0 w-full">
                    <div className="flex items-center gap-2 mb-0.5 min-w-0">
                      <h3
                        className={`text-base font-semibold truncate w-full max-w-full ${
                          hasValidMbid
                            ? "hover:underline cursor-pointer"
                            : "cursor-not-allowed opacity-75"
                        }`}
                        style={{ color: "#fff" }}
                        onClick={() => {
                          if (hasValidMbid) {
                            navigate(
                              isAlbum
                                ? `/artist/${artistMbid}`
                                : `/artist/${request.mbid}`,
                              {
                                state: {
                                  artistName: isAlbum
                                    ? artistName
                                    : displayName,
                                },
                              }
                            );
                          }
                        }}
                      >
                        {displayName}
                      </h3>
                    </div>

                    <div
                      className="text-xs flex flex-wrap items-center gap-3 min-w-0"
                      style={{ color: "#c1c1c3" }}
                    >
                      {isAlbum && artistName && (
                        <span className="flex items-center gap-1 truncate max-w-full">
                          <Music className="w-3 h-3" />
                          {artistName}
                        </span>
                      )}
                      <span className="flex items-center gap-1 truncate max-w-full">
                        <Clock className="w-3 h-3" />
                        {new Date(request.requestedAt).toLocaleDateString(
                          undefined,
                          {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          }
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0 sm:ml-auto">
                    {getStatusBadge(request)}
                    {isFailed && request.albumId && (
                      <button
                        type="button"
                        onClick={() => handleReSearchRequest(request)}
                        className="p-1.5 rounded hover:bg-white/10 transition-colors"
                        title="Re-search"
                        aria-label="Re-search"
                        disabled={isReSearching}
                      >
                        {isReSearching ? (
                          <Loader className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 p-4" style={{ backgroundColor: "#211f27" }}>
        <h4
          className="font-bold mb-2 text-sm flex items-center"
          style={{ color: "#fff" }}
        >
          Request Status Guide
        </h4>
        <div className="grid sm:grid-cols-4 gap-3 text-xs">
          <div className="flex gap-2" style={{ color: "#c1c1c3" }}>
            <div className="w-2 h-2 bg-yellow-500 mt-1.5 shrink-0"></div>
            <p>
              <strong>Requested:</strong> Album is in queue or has been
              requested but not yet imported.
            </p>
          </div>
          <div className="flex gap-2" style={{ color: "#c1c1c3" }}>
            <div className="w-2 h-2 bg-gray-600 mt-1.5 shrink-0"></div>
            <p>
              <strong>Processing:</strong> Album is downloading, importing, or
              searching. Check Lidarr for details.
            </p>
          </div>
          <div className="flex gap-2" style={{ color: "#c1c1c3" }}>
            <div className="w-2 h-2 bg-red-500 mt-1.5 shrink-0"></div>
            <p>
              <strong>Failed:</strong> Album search or import failed. You can
              re-search from the artist page.
            </p>
          </div>
          <div className="flex gap-2" style={{ color: "#c1c1c3" }}>
            <div className="w-2 h-2 bg-green-500 mt-1.5 shrink-0"></div>
            <p>
              <strong>Available:</strong> Album has been successfully imported
              and is available on disk.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RequestsPage;
