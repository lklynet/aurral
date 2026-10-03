import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  addStaticPlaylistTracks,
  createStaticPlaylist,
} from "../../utils/api/endpoints/playlists.js";
import {
  getDownloadStatus,
  downloadTrackToLibrary,
  lookupAlbumsInLibraryBatch,
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
} from "../../utils/api/endpoints/library.js";
import {
  getReleaseGroupCover,
  getReleaseGroupDetails,
  getReleaseGroupTracks,
} from "../../utils/api/endpoints/artists.js";
import { useStaticPlaylists } from "../../hooks/useStaticPlaylists";
import { useWebSocketChannel } from "../../hooks/useWebSocket";

import { Link, useLocation, useParams } from "react-router";
import { ExternalLink } from "lucide-react";
import AddActionButton from "../../components/AddActionButton";
import { useLibraryDestination } from "../../hooks/useLibraryDestination";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import {
  buildAlbumAddAction,
  countReleaseTracks,
  describeAlbumRequestResult,
} from "../../utils/albumAddAction";
import { buildAlbumRequestPayload } from "../../utils/libraryDestination";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import {
  ArtistDetailsReleaseTrackList,
  useReleasePreviewQueue,
} from "./components/ArtistDetailsReleaseTrackList";
import { CollectionHeader, CollectionPage, CollectionPlayButtons } from "../../components/CollectionHeader";
import { withImageCacheBust } from "../../utils/normalizeMediaUrl.js";
import { queryClient, queryKeys } from "../../queryClient.js";
import {
  buildStaticPlaylistTrackPayload,
  buildLastfmAlbumUrl,
  formatAlbumDuration,
  formatReleaseDate,
  getCoverImage,
  getReleaseMetric,
  reserveUniquePlaylistName,
  resolveReleaseLibraryDisplay,
  sumTrackDurationMs,
} from "./utils";
import Tooltip from "../../components/Tooltip";
import CrossViewLink from "../../components/CrossViewLink";
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
  const { showSuccess, showError, showInfo } = useToast();
  const libraryDestination = useLibraryDestination();
  const { isAlbumDownloading } = useActiveDownloads();
  const [ownerConflictState, setOwnerConflictState] = useState(null);
  const ownerConflict =
    ownerConflictState?.releaseMbid === releaseMbid ? ownerConflictState.conflict : null;
  const { hasPermission } = useAuth();
  const canAddAlbum = hasPermission("addAlbum");

  const focusTrackMbid = locationState?.focusTrackMbid || null;

  const baseRelease = useMemo(
    () => buildReleaseFromState(releaseMbid, locationState),
    [locationState, releaseMbid],
  );

  const releaseDetailsQuery = useQuery({
    queryKey: queryKeys.releaseGroupDetails(releaseMbid),
    queryFn: ({ signal }) => getReleaseGroupDetails(releaseMbid, { signal }),
    enabled: Boolean(releaseMbid),
    staleTime: 5 * 60 * 1000,
  });
  const release = useMemo(
    () => mergeReleaseDetails(baseRelease, releaseDetailsQuery.data),
    [baseRelease, releaseDetailsQuery.data],
  );
  const artistCredits = releaseDetailsQuery.data?.["artist-credit"];
  const artistName =
    locationState?.artistName ||
    (Array.isArray(artistCredits)
      ? artistCredits.find((credit) => credit?.artist?.id === artistMbid)?.name || ""
      : "");

  const [coverUrl, setCoverUrl] = useState(release._coverUrl || "");
  const [coverRetryUrl, setCoverRetryUrl] = useState("");
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [requestingAlbum, setRequestingAlbum] = useState(false);
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");
  const downloadTrackMutation = useMutation({ mutationFn: downloadTrackToLibrary });
  const requestAlbumMutation = useMutation({ mutationFn: requestAlbumFromSearch });
  const { mutateAsync: downloadTrack } = downloadTrackMutation;
  const { mutateAsync: requestAlbum } = requestAlbumMutation;

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

  const releaseTitle = release.title || "Release";
  const playbackSource = useMemo(
    () => ({ type: "release", id: releaseMbid, label: releaseTitle }),
    [releaseMbid, releaseTitle],
  );
  const preview = useReleasePreviewQueue({
    release,
    trackKey: releaseMbid,
    tracks,
    artistName,
    artistMbid,
    playbackSource,
  });
  const pageTitle = artistName ? `${releaseTitle} — ${artistName}` : releaseTitle;
  useDocumentTitle(pageTitle);

  const releaseTypeLabel = getReleaseTypeLabel(release);
  const releaseDateLabel = formatReleaseDate(release);
  const trackCount = tracks.length;
  const totalDurationMs = useMemo(() => sumTrackDurationMs(tracks), [tracks]);
  const durationLabel = formatAlbumDuration(totalDurationMs);
  const metric = getReleaseMetric(release);
  const libraryDisplay = useMemo(
    () => resolveReleaseLibraryDisplay(
      countReleaseTracks(libraryInfo, trackCount),
      downloadStatus,
    ),
    [downloadStatus, libraryInfo, trackCount],
  );
  const isComplete = libraryDisplay.isComplete;
  const triggerSearch = libraryDisplay.triggerSearch;
  const albumAddAction = buildAlbumAddAction(triggerSearch, libraryDestination);
  const albumDownloading =
    !isComplete &&
    (isAlbumDownloading(releaseMbid) || ACTIVE_DOWNLOAD_STATUSES.has(String(downloadStatus?.status)));
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
    setCoverRetryUrl("");
    setCoverLoadFailed(false);
  }, [release._coverUrl, releaseMbid]);

  useEffect(() => {
    setCoverRetryUrl("");
  }, [coverUrl]);

  const handleCoverError = async () => {
    if (!releaseMbid || !coverUrl || coverLoadFailed) return;
    if (coverRetryUrl) {
      setCoverRetryUrl("");
      setCoverUrl("");
      setCoverLoadFailed(true);
      return;
    }
    setCoverRetryUrl(withImageCacheBust(coverUrl));
    try {
      const response = await getReleaseGroupCover(releaseMbid, {
        artistName,
        albumTitle: release.title,
        bypassCache: true,
      });
      const refreshedUrl = getCoverImage(response?.images);
      if (refreshedUrl && refreshedUrl !== coverUrl) {
        setCoverUrl(refreshedUrl);
        setCoverLoadFailed(false);
      } else if (!refreshedUrl) {
        setCoverRetryUrl("");
        setCoverUrl("");
        setCoverLoadFailed(true);
      }
    } catch {
      setCoverRetryUrl("");
      setCoverUrl("");
      setCoverLoadFailed(true);
    }
  };

  useEffect(() => {
    if (tracksQuery.error) showError("Failed to load tracks");
  }, [showError, tracksQuery.error]);

  useEffect(() => {
    if (!releaseMbid || coverUrl || coverLoadFailed) return undefined;
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
  }, [artistName, coverLoadFailed, coverUrl, release.title, releaseMbid]);

  const getDefaultTrackPlaylistName = useCallback(
    (track) =>
      reserveUniquePlaylistName(
        staticPlaylists,
        `${artistName || track?.artistName || "Artist"} Picks`,
      ),
    [artistName, staticPlaylists],
  );

  const buildReleaseTrackPayload = useCallback(
    (track) => {
      const year = String(release["first-release-date"] || "").slice(0, 4);
      return buildStaticPlaylistTrackPayload({
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
            reserveUniquePlaylistName(staticPlaylists, `${trackPayload.artistName} Picks`);
          const response = await createStaticPlaylist({
            name,
            tracks: [trackPayload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = staticPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addStaticPlaylistTracks(target.playlistId, {
            tracks: [trackPayload],
          });
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) {
          setStaticPlaylists(nextPlaylists);
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
    [loadStaticPlaylists, setPlaylistModalError, setStaticPlaylists, staticPlaylists, showError, showSuccess],
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
        const result = await downloadTrack(payload);
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
    [buildReleaseTrackPayload, downloadTrack, showError, showSuccess],
  );

  const handleAlbumAction = useCallback(async (managedBy) => {
    if (!releaseMbid || requestingAlbum) return;
    setRequestingAlbum(true);
    try {
      const result = await requestAlbum(buildAlbumRequestPayload({
        albumMbid: releaseMbid,
        albumName: release.title,
        artistMbid,
        artistName,
        managedBy,
        triggerSearch,
      }));
      const addedAlbum = result?.album;
      let entry = null;
      if (addedAlbum?.id != null) {
        const statistics = addedAlbum.statistics || {};
        const sizeOnDisk = Number(statistics.sizeOnDisk || 0);
        const trackFileCount = Number(statistics.trackFileCount || 0);
        entry = {
          inLibrary: true,
          managedBy: addedAlbum.managedBy || result?.managedBy || managedBy,
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
      const outcome = describeAlbumRequestResult(result, release.title || "album", managedBy);
      (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
    } catch (err) {
      const conflict = settleLibraryOwnerConflict(err);
      if (conflict) {
        setOwnerConflictState({ releaseMbid, conflict });
        showInfo(`${release.title || "Album"}: ${conflict.message}`);
        return;
      }
      showError(`Could not download the album: ${
        err.response?.data?.message || err.response?.data?.error || err.message
      }`);
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
    requestAlbum,
    showError,
    showInfo,
    showSuccess,
  ]);

  const artistLinkState = {
    artistName,
    inLibrary: locationState?.inLibrary,
    libraryArtist: locationState?.libraryArtist,
  };

  return (
    <CollectionPage tintSrc={coverUrl}>
      <CollectionHeader
        cover={
          coverUrl ? (
            <img
              src={coverRetryUrl || coverUrl}
              alt=""
              loading="eager"
              decoding="async"
              onError={() => void handleCoverError()}
            />
          ) : (
            <span className="native-library-cover-fallback" aria-hidden="true">
              {releaseTitle.trim().charAt(0).toUpperCase() || "—"}
            </span>
          )
        }
        kicker={releaseTypeLabel || "Release"}
        title={releaseTitle}
        subtitle={
          artistMbid ? (
            <Link to={`/artist/${artistMbid}`} state={artistLinkState} className="native-library-detail__artist">
              {artistName || "Artist"}
            </Link>
          ) : null
        }
        meta={releaseMeta}
        actions={
          <>
            <CollectionPlayButtons
              label={`${releaseTitle} previews`}
              disabled={preview.disabled}
              isPlaying={preview.isListPlaying}
              isShuffleEnabled={preview.isShuffleEnabled}
              onPlay={preview.handlePlayAll}
              onShuffle={preview.handleShufflePlay}
            />
            {canAddAlbum && !isComplete ? (
              <AddActionButton
                {...albumAddAction}
                ownerConflict={ownerConflict}
                onAdd={handleAlbumAction}
                isLoading={requestingAlbum || albumDownloading}
                loadingLabel="Downloading"
                disabled={requestingAlbum || albumDownloading}
              />
            ) : null}
            {libraryInfo?.canonicalInLibrary ? (
              <CrossViewLink view="library" to={libraryPath} />
            ) : libraryDisplay.label ? (
              <Tooltip content={libraryDisplay.label}>
                <span
                  className={`release-page__library-status release-page__library-status--${libraryDisplay.kind}`}
                >
                  <span>{libraryDisplay.label}</span>
                </span>
              </Tooltip>
            ) : null}
            {lastfmUrl ? (
              <Tooltip content="Open on Last.fm">
                <a
                  href={lastfmUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="native-library-favorite"
                  aria-label="Open on Last.fm"
                >
                  <ExternalLink aria-hidden="true" />
                </a>
              </Tooltip>
            ) : null}
          </>
        }
      />
      <ArtistDetailsReleaseTrackList
        release={release}
        trackKey={releaseMbid}
        tracks={tracks}
        loading={loadingTracks}
        preview={preview}
        playbackSource={playbackSource}
        onAddTrackToPlaylist={handleReleaseTrackAdd}
        onAddTrackToLibrary={handleReleaseTrackAddToLibrary}
        libraryTrackSavingKey={libraryTrackSavingKey}
        albumDownloading={albumDownloading}
        ownedTrackMbids={libraryInfo?.ownedTrackMbids}
        resolveMembershipTrack={buildReleaseTrackPayload}
        playlists={staticPlaylists}
        playlistsLoading={playlistModalLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistError={playlistModalError}
        getDefaultPlaylistName={getDefaultTrackPlaylistName}
        onLoadPlaylists={loadStaticPlaylists}
        highlightTrackId={focusTrackMbid}
      />
    </CollectionPage>
  );
}

export default ReleasePage;
