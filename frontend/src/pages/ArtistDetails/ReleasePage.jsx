import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
} from "../../utils/api/endpoints/playlists.js";
import {
  getDownloadStatus,
  downloadTrackToLibrary,
  lookupAlbumsInLibraryBatch,
  requestAlbumFromSearch,
} from "../../utils/api/endpoints/library.js";
import {
  getReleaseGroupCover,
  getReleaseGroupDetails,
  getReleaseGroupTracks,
} from "../../utils/api/endpoints/artists.js";
import { useSharedPlaylists } from "../../hooks/useSharedPlaylists";
import { useWebSocketChannel } from "../../hooks/useWebSocket";

import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { CornerUpLeft, ExternalLink, Library, Music } from "lucide-react";
import AddActionButton from "../../components/AddActionButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { ArtistDetailsReleaseTrackList } from "./components/ArtistDetailsReleaseTrackList";
import { extractTwoToneGradientFromImage } from "../../utils/imageColors";
import { queryClient, queryKeys } from "../../queryClient.js";
import {
  buildSharedPlaylistTrackPayload,
  buildLastfmAlbumUrl,
  formatAlbumDuration,
  formatReleaseDate,
  getReleaseMetric,
  reserveUniquePlaylistName,
  resolveReleaseLibraryDisplay,
  sumTrackDurationMs,
} from "./utils";
const getReleaseTypeLabel = (release) => {
  const types = [
    release?.["primary-type"],
    ...(Array.isArray(release?.["secondary-types"]) ? release["secondary-types"] : []),
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
    "first-release-date": details["first-release-date"] || baseRelease["first-release-date"],
    "primary-type": details["primary-type"] || baseRelease["primary-type"],
    "secondary-types":
      Array.isArray(details["secondary-types"]) && details["secondary-types"].length
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
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const canAddAlbum = hasPermission("addAlbum");

  const artistName = locationState?.artistName || "";
  const focusTrackMbid = locationState?.focusTrackMbid || null;

  const baseRelease = useMemo(
    () => buildReleaseFromState(releaseMbid, locationState),
    [locationState, releaseMbid],
  );

  const releaseDetailsQuery = useQuery({
    queryKey: queryKeys.releaseGroupDetails(releaseMbid),
    queryFn: ({ signal }) => getReleaseGroupDetails(releaseMbid, { signal }),
    enabled: Boolean(releaseMbid) && (Boolean(release.title) || releaseDetailsQuery.isFetched),
    staleTime: 5 * 60 * 1000,
  });
  const release = useMemo(
    () => mergeReleaseDetails(baseRelease, releaseDetailsQuery.data),
    [baseRelease, releaseDetailsQuery.data],
  );

  const [coverUrl, setCoverUrl] = useState(release._coverUrl || "");
  const [requestingAlbum, setRequestingAlbum] = useState(false);
  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");

  const trackContext = useMemo(
    () => ({
      artistMbid,
      artistName,
      albumTitle: release.title,
      releaseType: release["primary-type"] || "",
      releaseDate: release["first-release-date"] || "",
      deezerAlbumId: release._deezerAlbumId || "",
    }),
    [artistMbid, artistName, release],
  );
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(releaseMbid, trackContext),
    queryFn: ({ signal }) => getReleaseGroupTracks(releaseMbid, { ...trackContext, signal }),
    enabled: Boolean(releaseMbid),
    staleTime: 5 * 60 * 1000,
  });
  const tracks = useMemo(
    () => (Array.isArray(tracksQuery.data) ? tracksQuery.data : []),
    [tracksQuery.data],
  );
  const loadingTracks = tracksQuery.isPending;
  const albumLookupQuery = useQuery({
    queryKey: queryKeys.libraryAlbumLookup(releaseMbid ? [releaseMbid] : []),
    queryFn: ({ signal }) =>
      lookupAlbumsInLibraryBatch([releaseMbid], { signal, bypassCache: true }),
    enabled: Boolean(releaseMbid),
    staleTime: 15_000,
  });
  const libraryInfo = useMemo(() => {
    const entry = albumLookupQuery.data?.[releaseMbid];
    return entry?.inLibrary ? entry : null;
  }, [albumLookupQuery.data, releaseMbid]);
  const libraryAlbumId = libraryInfo?.libraryAlbumId ? String(libraryInfo.libraryAlbumId) : null;
  const { isConnected: downloadStatusWsConnected } = useWebSocketChannel(
    "downloads",
    (msg) => {
      if (msg?.type !== "download_statuses" || !libraryAlbumId) return;
      const next = msg.statuses?.[libraryAlbumId];
      if (!next) return;
      queryClient.setQueryData(
        queryKeys.downloadStatus([libraryAlbumId]),
        (current) => ({ ...(current || {}), [libraryAlbumId]: next }),
      );
      if (next.status === "added") {
        queryClient.invalidateQueries({
          queryKey: queryKeys.libraryAlbumLookup([releaseMbid]),
        });
      }
    },
    { enabled: Boolean(libraryAlbumId) },
  );
  const downloadStatusQuery = useQuery({
    queryKey: queryKeys.downloadStatus(libraryAlbumId ? [libraryAlbumId] : []),
    queryFn: ({ signal }) =>
      getDownloadStatus([libraryAlbumId], { signal, bypassCache: true }),
    enabled: Boolean(libraryAlbumId),
    staleTime: 4_000,
    refetchInterval: (currentQuery) => {
      if (!libraryAlbumId || downloadStatusWsConnected || (typeof document !== "undefined" && document.hidden)) {
        return false;
      }
      const status = currentQuery.state.data?.[libraryAlbumId]?.status;
      return ACTIVE_DOWNLOAD_STATUSES.has(String(status)) || status === "failed" ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const downloadStatus = downloadStatusQuery.data?.[libraryAlbumId] || null;

  const [heroColor, setHeroColor] = useState(null);
  const colorRequestRef = useRef(null);

  useEffect(() => {
    if (!coverUrl) {
      setHeroColor(null);
      return;
    }
    const url = coverUrl;
    colorRequestRef.current = url;
    extractTwoToneGradientFromImage(url).then((result) => {
      if (colorRequestRef.current === url && result?.top) {
        setHeroColor(result.top);
      }
    });
    return () => {
      if (colorRequestRef.current === url) {
        colorRequestRef.current = null;
      }
    };
  }, [coverUrl]);

  const releaseTitle = release.title || "Release";
  const pageTitle = artistName ? `${releaseTitle} — ${artistName}` : releaseTitle;
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
  const triggerSearch = libraryDisplay.triggerSearch;
  const lastfmUrl = artistName && releaseTitle ? buildLastfmAlbumUrl(artistName, releaseTitle) : "";

  const releaseMeta = [
    releaseDateLabel,
    releaseTypeLabel,
    trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : null,
    durationLabel,
    metric.label ? (metric.type === "rating" ? `${metric.label} rating` : metric.label) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const libraryPath = libraryInfo?.canonicalAlbumId
    ? `/library/album/${encodeURIComponent(libraryInfo.canonicalAlbumId)}`
    : `/library/albums?query=${encodeURIComponent(releaseTitle)}`;

  useEffect(() => {
    setCoverUrl(release._coverUrl || "");
  }, [release._coverUrl]);

  useEffect(() => {
    if (tracksQuery.error) showError("Failed to load tracks");
  }, [showError, tracksQuery.error]);

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
      return buildSharedPlaylistTrackPayload({
        artistName: artistName || "",
        trackName: track?.trackName || track?.title || "",
        albumName: release.title || "",
        artistMbid: artistMbid || "",
        albumMbid: releaseMbid || "",
        trackMbid: track?.mbid || track?.id || "",
        releaseYear: year,
        durationMs: track?.length,
        reason: null,
      });
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
            reserveUniquePlaylistName(sharedPlaylists, `${trackPayload.artistName} Picks`);
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
    [loadSharedPlaylists, setPlaylistModalError, setSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const handleReleaseTrackAdd = useCallback(
    (track, _release, target) => {
      const payload = buildReleaseTrackPayload(track);
      const savingKey = String(track?.id ?? track?.mbid ?? "");
      return saveTrackToPlaylist(payload, target, savingKey);
    },
    [buildReleaseTrackPayload, saveTrackToPlaylist],
  );

  const handleReleaseTrackAddToLibrary = useCallback(
    async (track) => {
      const payload = buildReleaseTrackPayload(track);
      const savingKey = String(track?.id ?? track?.mbid ?? "");
      setLibraryTrackSavingKey(savingKey);
      try {
        const result = await downloadTrackToLibrary(payload);
        showSuccess(
          result?.alreadyOwned
            ? `${payload.trackName} is already in your library`
            : result?.queued
              ? `Queued ${payload.trackName} for your library`
              : `Added ${payload.trackName} to your library`,
        );
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add track to library",
        );
      } finally {
        setLibraryTrackSavingKey("");
      }
    },
    [buildReleaseTrackPayload, showError, showSuccess],
  );

  const handleAlbumAction = useCallback(async () => {
    if (!releaseMbid || requestingAlbum) return;
    setRequestingAlbum(true);
    try {
      const result = await requestAlbumFromSearch({
        albumMbid: releaseMbid,
        albumName: release.title,
        artistMbid,
        artistName,
        triggerSearch,
      });
      const addedAlbum = result?.album;
      let entry = null;
      if (addedAlbum?.id != null) {
        const statistics = addedAlbum.statistics || {};
        const sizeOnDisk = Number(statistics.sizeOnDisk || 0);
        const trackFileCount = Number(statistics.trackFileCount || 0);
        entry = {
          inLibrary: true,
          libraryAlbumId: String(addedAlbum.id),
          libraryArtistId:
            addedAlbum.artistId != null ? String(addedAlbum.artistId) : null,
          status:
            sizeOnDisk > 0 || trackFileCount > 0
              ? "available"
              : addedAlbum.monitored
                ? "monitored"
                : "unmonitored",
          monitored: Boolean(addedAlbum.monitored),
          percentOfTracks: Number(statistics.percentOfTracks || 0),
          sizeOnDisk,
          trackCount: Number(statistics.trackCount || 0),
          trackFileCount,
          albumName: addedAlbum.albumName || release.title || "",
          releaseDate: addedAlbum.releaseDate || "",
        };
      } else {
        const lookup = await lookupAlbumsInLibraryBatch([releaseMbid], { bypassCache: true });
        entry = lookup?.[releaseMbid] || null;
      }
      if (entry?.inLibrary) {
        queryClient.setQueryData(
          queryKeys.libraryAlbumLookup([releaseMbid]),
          (current) => ({ ...(current || {}), [releaseMbid]: entry }),
        );
        if (entry.libraryAlbumId) {
          const id = String(entry.libraryAlbumId);
          queryClient.setQueryData(
            queryKeys.downloadStatus([id]),
            (current) => ({
              ...(current || {}),
              [id]: { ...(current?.[id] || {}), status: result?.status || "searching" },
            }),
          );
        }
      }
      showSuccess(
        triggerSearch
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
    triggerSearch,
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
    <div
      className="artist-details-page release-page"
      style={
        heroColor
          ? { background: `linear-gradient(180deg, ${heroColor} 0%, ${heroColor} 120px, var(--aurral-surface) 400px)` }
          : undefined
      }
    >
      <div className="artist-page-header">
        <div>
          <div className="artist-title-link release-page__title-nav">
            <Link to={`/artist/${artistMbid}`} state={artistLinkState}>
              <span>{artistName || "Artist"}</span>
            </Link>
            <span className="release-page__title-nav-separator" aria-hidden="true">
              /
            </span>
            <Link
              to={`/artist/${artistMbid}/albums`}
              state={artistLinkState}
              className="release-page__title-nav-albums"
            >
              <span>Albums</span>
              <CornerUpLeft className="artist-icon-lg" />
            </Link>
          </div>
        </div>
      </div>

      <div className="release-page__hero">
        <div className="release-page__cover">
          {coverUrl ? (
            <img src={coverUrl} alt={releaseTitle} loading="eager" decoding="async" />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
        </div>
        <div className="release-page__copy">
          <h1 className="release-page__title">{releaseTitle}</h1>
          {artistMbid ? (
            <Link
              to={`/artist/${artistMbid}`}
              state={artistLinkState}
              className="artist-link-button release-page__artist"
            >
              {artistName || "Artist"}
            </Link>
          ) : null}
          {releaseMeta ? (
            <p className="artist-card-meta release-page__meta">{releaseMeta}</p>
          ) : null}
          <div className="release-page__actions">
            {libraryInfo?.canonicalInLibrary ? (
              <button
                type="button"
                className="btn btn-surface btn-sm release-page__external-link"
                onClick={() => navigate(libraryPath)}
              >
                <Library className="artist-icon-sm" />
                Open in library
              </button>
            ) : libraryDisplay.label ? (
              <span
                className={`release-page__library-status release-page__library-status--${libraryDisplay.kind}`}
                title={libraryDisplay.label}
              >
                <span>{libraryDisplay.label}</span>
              </span>
            ) : null}
            {canAddAlbum && !isComplete ? (
              <AddActionButton
                onClick={handleAlbumAction}
                isLoading={requestingAlbum}
                disabled={requestingAlbum}
                label={triggerSearch ? "Search Album" : "Add to Lidarr"}
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
          artistMbid={artistMbid}
          playbackSource={{
            type: "release",
            id: releaseMbid,
            label: releaseTitle,
          }}
          onAddTrackToPlaylist={handleReleaseTrackAdd}
          onAddTrackToLibrary={handleReleaseTrackAddToLibrary}
          libraryTrackSavingKey={libraryTrackSavingKey}
          ownedTrackMbids={libraryInfo?.ownedTrackMbids}
          resolveMembershipTrack={buildReleaseTrackPayload}
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
