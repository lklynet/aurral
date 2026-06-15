import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { CornerUpLeft, ExternalLink, Music } from "lucide-react";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
import AddAlbumButton from "../../components/AddAlbumButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { ArtistDetailsReleaseTrackList } from "./components/ArtistDetailsReleaseTrackList";
import {
  buildLastfmAlbumUrl,
  formatAlbumDuration,
  formatReleaseDate,
  getReleaseMetric,
  resolveReleaseLibraryDisplay,
  sumTrackDurationMs,
} from "./utils";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
  getDownloadStatus,
  getFlowStatus,
  getReleaseGroupCover,
  getReleaseGroupDetails,
  getReleaseGroupTracks,
  lookupAlbumsInLibraryBatch,
  requestAlbumFromSearch,
} from "../../utils/api";

const normalizePlaylistNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const reserveUniquePlaylistName = (playlists, baseName = "Playlist") => {
  const normalizedBase = String(baseName || "").trim() || "Playlist";
  const existing = new Set(
    (Array.isArray(playlists) ? playlists : [])
      .map((playlist) => normalizePlaylistNameKey(playlist?.name))
      .filter(Boolean),
  );
  if (!existing.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

const getReleaseTypeLabel = (release) => {
  const types = [
    release?.["primary-type"],
    ...(Array.isArray(release?.["secondary-types"])
      ? release["secondary-types"]
      : []),
  ].filter(Boolean);
  return types.length ? types.join(" · ") : null;
};

const buildReleaseFromState = (releaseMbid, locationState) => {
  const focusRelease = locationState?.focusReleaseGroup || {};
  const title = String(focusRelease.title || "").trim();
  return {
    id: releaseMbid,
    title,
    "first-release-date": focusRelease.firstReleaseDate || "",
    "primary-type": focusRelease.primaryType || "Album",
    "secondary-types": Array.isArray(focusRelease.secondaryTypes)
      ? focusRelease.secondaryTypes
      : [],
    rating: focusRelease.rating || null,
    _coverUrl: focusRelease.coverUrl || "",
    _deezerAlbumId: focusRelease.deezerAlbumId || "",
  };
};

const mergeReleaseDetails = (baseRelease, details) => {
  if (!details) return baseRelease;
  return {
    ...baseRelease,
    title: details.title || baseRelease.title,
    "first-release-date":
      details["first-release-date"] || baseRelease["first-release-date"],
    "primary-type": details["primary-type"] || baseRelease["primary-type"],
    "secondary-types":
      Array.isArray(details["secondary-types"]) &&
      details["secondary-types"].length
        ? details["secondary-types"]
        : baseRelease["secondary-types"],
    rating: details.rating || baseRelease.rating || null,
    _coverUrl: details.coverUrl || baseRelease._coverUrl || "",
  };
};

const ACTIVE_DOWNLOAD_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

function ReleasePage() {
  const { mbid: artistMbid, releaseMbid } = useParams();
  const { state: locationState } = useLocation();
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const canAddAlbum = hasPermission("addAlbum");

  const artistName = locationState?.artistName || "";
  const focusTrackMbid = locationState?.focusTrackMbid || null;

  const baseRelease = useMemo(
    () => buildReleaseFromState(releaseMbid, locationState),
    [locationState, releaseMbid],
  );

  const [releaseDetails, setReleaseDetails] = useState(null);
  const release = useMemo(
    () => mergeReleaseDetails(baseRelease, releaseDetails),
    [baseRelease, releaseDetails],
  );

  const [coverUrl, setCoverUrl] = useState(release._coverUrl || "");
  const [tracks, setTracks] = useState([]);
  const [loadingTracks, setLoadingTracks] = useState(true);
  const [libraryInfo, setLibraryInfo] = useState(null);
  const [downloadStatus, setDownloadStatus] = useState(null);
  const [requestingAlbum, setRequestingAlbum] = useState(false);
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  const releaseTitle = release.title || "Release";
  const pageTitle = artistName
    ? `${releaseTitle} — ${artistName}`
    : releaseTitle;
  useDocumentTitle(pageTitle);

  const releaseTypeLabel = getReleaseTypeLabel(release);
  const releaseDateLabel = formatReleaseDate(release);
  const trackCount = tracks.length;
  const totalDurationMs = useMemo(() => sumTrackDurationMs(tracks), [tracks]);
  const durationLabel = formatAlbumDuration(totalDurationMs);
  const metric = getReleaseMetric(release);
  const libraryDisplay = useMemo(
    () => resolveReleaseLibraryDisplay(libraryInfo, downloadStatus),
    [downloadStatus, libraryInfo],
  );
  const isComplete = libraryDisplay.isComplete;
  const isInLibrary = libraryDisplay.isInLibrary;
  const lastfmUrl =
    artistName && releaseTitle
      ? buildLastfmAlbumUrl(artistName, releaseTitle)
      : "";

  const releaseMeta = [
    releaseDateLabel,
    releaseTypeLabel,
    trackCount > 0
      ? `${trackCount} track${trackCount === 1 ? "" : "s"}`
      : null,
    durationLabel,
    metric.label
      ? metric.type === "rating"
        ? `${metric.label} rating`
        : metric.label
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    setCoverUrl(release._coverUrl || "");
  }, [release._coverUrl]);

  useEffect(() => {
    if (!releaseMbid) return undefined;
    let cancelled = false;

    getReleaseGroupDetails(releaseMbid)
      .then((details) => {
        if (!cancelled && details) {
          setReleaseDetails(details);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [releaseMbid]);

  useEffect(() => {
    if (!releaseMbid) return undefined;
    let cancelled = false;

    const loadLibraryStatus = async () => {
      try {
        const lookup = await lookupAlbumsInLibraryBatch([releaseMbid]);
        const entry = lookup?.[releaseMbid];
        if (cancelled) return;
        if (!entry?.inLibrary) {
          setLibraryInfo(null);
          setDownloadStatus(null);
          return;
        }
        setLibraryInfo(entry);
        if (!entry.libraryAlbumId) {
          setDownloadStatus(null);
          return;
        }
        const statuses = await getDownloadStatus([entry.libraryAlbumId]);
        if (!cancelled) {
          setDownloadStatus(statuses?.[entry.libraryAlbumId] || null);
        }
      } catch {
        if (!cancelled) {
          setLibraryInfo(null);
          setDownloadStatus(null);
        }
      }
    };

    loadLibraryStatus();
    return () => {
      cancelled = true;
    };
  }, [releaseMbid]);

  useEffect(() => {
    if (!libraryInfo?.libraryAlbumId || isComplete) return undefined;
    const status = String(downloadStatus?.status || "");
    if (!ACTIVE_DOWNLOAD_STATUSES.has(status) && status !== "failed") {
      return undefined;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const statuses = await getDownloadStatus([libraryInfo.libraryAlbumId]);
        if (cancelled) return;
        const next = statuses?.[libraryInfo.libraryAlbumId] || null;
        setDownloadStatus(next);
        if (next?.status === "added") {
          const lookup = await lookupAlbumsInLibraryBatch([releaseMbid]);
          const entry = lookup?.[releaseMbid];
          if (entry?.inLibrary) {
            setLibraryInfo(entry);
          }
        }
      } catch {}
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    downloadStatus?.status,
    isComplete,
    libraryInfo?.libraryAlbumId,
    releaseMbid,
  ]);

  useEffect(() => {
    if (!releaseMbid || coverUrl) return undefined;
    let cancelled = false;

    const loadCover = async () => {
      try {
        const response = await getReleaseGroupCover(releaseMbid, {
          artistName,
          albumTitle: release.title,
        });
        const image = response?.images?.[0]?.image;
        if (!cancelled && image) {
          setCoverUrl(image);
        }
      } catch {}
    };

    loadCover();
    return () => {
      cancelled = true;
    };
  }, [artistName, coverUrl, release.title, releaseMbid]);

  useEffect(() => {
    if (!releaseMbid) return undefined;
    let cancelled = false;
    setLoadingTracks(true);

    const loadTracks = async () => {
      try {
        const nextTracks = await getReleaseGroupTracks(releaseMbid, {
          artistMbid,
          artistName,
          albumTitle: release.title,
          releaseType: release["primary-type"] || "",
          releaseDate: release["first-release-date"] || "",
          deezerAlbumId: release._deezerAlbumId || "",
        });
        if (!cancelled) {
          setTracks(Array.isArray(nextTracks) ? nextTracks : []);
        }
      } catch {
        if (!cancelled) {
          showError("Failed to load tracks");
          setTracks([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingTracks(false);
        }
      }
    };

    loadTracks();
    return () => {
      cancelled = true;
    };
  }, [
    artistMbid,
    artistName,
    release,
    releaseMbid,
    showError,
  ]);

  const loadSharedPlaylists = useCallback(async () => {
    setPlaylistModalLoading(true);
    try {
      const data = await getFlowStatus();
      const playlists = Array.isArray(data?.sharedPlaylists)
        ? data.sharedPlaylists
        : [];
      setSharedPlaylists(playlists);
      return playlists;
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to load playlists";
      setPlaylistModalError(message);
      showError(message);
      return null;
    } finally {
      setPlaylistModalLoading(false);
    }
  }, [showError]);

  const getDefaultTrackPlaylistName = useCallback(
    (track) =>
      reserveUniquePlaylistName(
        sharedPlaylists,
        `${artistName || track?.artistName || "Artist"} Picks`,
      ),
    [artistName, sharedPlaylists],
  );

  const buildReleaseTrackPayload = useCallback(
    (track) => {
      const year = String(release["first-release-date"] || "").slice(0, 4);
      return {
        artistName: artistName || "",
        trackName: track?.trackName || track?.title || "",
        albumName: release.title || "",
        artistMbid: artistMbid || "",
        albumMbid: releaseMbid || "",
        trackMbid: track?.mbid || track?.id || "",
        releaseYear: year || null,
        durationMs:
          track?.length != null && Number.isFinite(Number(track.length))
            ? Number(track.length)
            : null,
        reason: null,
        artistAliases: [],
      };
    },
    [artistMbid, artistName, release, releaseMbid],
  );

  const saveTrackToPlaylist = useCallback(
    async (trackPayload, target, savingKey) => {
      if (!trackPayload?.artistName || !trackPayload?.trackName) {
        showError("Track details are incomplete");
        return;
      }
      setPlaylistModalError("");
      setPlaylistMenuSavingKey(String(savingKey || ""));
      try {
        if (target?.mode === "new") {
          const name =
            String(target?.name || "").trim() ||
            reserveUniquePlaylistName(
              sharedPlaylists,
              `${trackPayload.artistName} Picks`,
            );
          const response = await createSharedPlaylist({
            name,
            tracks: [trackPayload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = sharedPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target.playlistId, {
            tracks: [trackPayload],
          });
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) {
          setSharedPlaylists(nextPlaylists);
        }
      } catch (err) {
        const message =
          err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to save track to playlist";
        setPlaylistModalError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [loadSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const handleReleaseTrackAdd = useCallback(
    (track, _release, target) => {
      const payload = buildReleaseTrackPayload(track);
      const savingKey = String(track?.id ?? track?.mbid ?? "");
      return saveTrackToPlaylist(payload, target, savingKey);
    },
    [buildReleaseTrackPayload, saveTrackToPlaylist],
  );

  const handleAlbumAction = useCallback(async () => {
    if (!releaseMbid || requestingAlbum) return;
    setRequestingAlbum(true);
    try {
      await requestAlbumFromSearch({
        albumMbid: releaseMbid,
        albumName: release.title,
        artistMbid,
        artistName,
        triggerSearch: isInLibrary,
      });
      const lookup = await lookupAlbumsInLibraryBatch([releaseMbid]);
      const entry = lookup?.[releaseMbid];
      if (entry?.inLibrary) {
        setLibraryInfo(entry);
        if (entry.libraryAlbumId) {
          const statuses = await getDownloadStatus([entry.libraryAlbumId]);
          setDownloadStatus(statuses?.[entry.libraryAlbumId] || null);
        }
      }
      showSuccess(
        isInLibrary
          ? `Searching for ${release.title || "album"}`
          : `Added ${release.title || "album"} to Lidarr`,
      );
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to add album",
      );
    } finally {
      setRequestingAlbum(false);
    }
  }, [
    artistMbid,
    artistName,
    isInLibrary,
    release.title,
    releaseMbid,
    requestingAlbum,
    showError,
    showSuccess,
  ]);

  const artistLinkState = {
    artistName,
    inLibrary: locationState?.inLibrary,
    libraryArtist: locationState?.libraryArtist,
  };

  return (
    <div className="artist-details-page release-page">
      <div className="artist-page-header">
        <div>
          <Link
            to={`/artist/${artistMbid}/albums`}
            state={artistLinkState}
            className="artist-title-link"
          >
            <span>{artistName || "Artist"}</span>
            <CornerUpLeft className="artist-icon-lg" />
          </Link>
        </div>
      </div>

      <div className="release-page__hero">
        <div className="release-page__cover">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={releaseTitle}
              loading="eager"
              decoding="async"
            />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
        </div>
        <div className="release-page__copy">
          <h1 className="release-page__title">{releaseTitle}</h1>
          {artistName ? (
            <Link
              to={`/artist/${artistMbid}`}
              state={artistLinkState}
              className="artist-link-button release-page__artist"
            >
              {artistName}
            </Link>
          ) : null}
          {releaseMeta ? (
            <p className="artist-card-meta release-page__meta">{releaseMeta}</p>
          ) : null}
          <div className="release-page__actions">
            {isComplete ? (
              <span className="release-page__library-status" title="In library">
                <SearchLibraryCheck />
                <span>In library</span>
              </span>
            ) : libraryDisplay.label ? (
              <span
                className={`release-page__library-status release-page__library-status--${libraryDisplay.kind}`}
                title={libraryDisplay.label}
              >
                <span>{libraryDisplay.label}</span>
              </span>
            ) : null}
            {canAddAlbum && !isComplete ? (
              <AddAlbumButton
                onClick={handleAlbumAction}
                isLoading={requestingAlbum}
                disabled={requestingAlbum}
                label={isInLibrary ? "Search Album" : "Add to Lidarr"}
              />
            ) : null}
            {lastfmUrl ? (
              <a
                href={lastfmUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-surface btn-sm release-page__external-link"
              >
                <ExternalLink className="artist-icon-sm" />
                Last.fm
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="release-page__tracks">
        <ArtistDetailsReleaseTrackList
          release={release}
          trackKey={releaseMbid}
          tracks={tracks}
          loading={loadingTracks}
          artistName={artistName}
          playbackSource={{
            type: "release",
            id: releaseMbid,
            label: releaseTitle,
          }}
          onAddTrackToPlaylist={handleReleaseTrackAdd}
          playlists={sharedPlaylists}
          playlistsLoading={playlistModalLoading}
          playlistSavingKey={playlistMenuSavingKey}
          playlistError={playlistModalError}
          getDefaultPlaylistName={getDefaultTrackPlaylistName}
          onLoadPlaylists={loadSharedPlaylists}
          highlightTrackId={focusTrackMbid}
        />
      </div>
    </div>
  );
}

export default ReleasePage;
