import { Fragment, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertCircle, EyeOff, Search, Share } from "../../components/icons";
import AddActionButton from "../../components/AddActionButton";
import { formatReleaseWait, isAwaitingRelease } from "../../utils/aurralAlbumStatus.ts";
import { AurralAlbumStatus } from "../../components/AurralAlbumStatus";
import ReleaseWaitBadge from "../../components/ReleaseWaitBadge";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../../components/CollectionHeader";
import { LibraryItemMenu, type LibraryMenuItem } from "../../components/LibraryItemMenu";
import RouteLink from "../../components/RouteLink";
import {
  SkeletonShape,
  SkeletonStatus,
  SkeletonText,
  SkeletonTrackList,
} from "../../components/Skeletons";
import Tooltip from "../../components/Tooltip";
import { FavoriteButton, TrackList, type TrackListRow } from "../../components/TrackList";
import { useAuth } from "../../contexts/AuthContext";
import { useAudioQueue } from "../../contexts/audioQueueContext";
import { useDiscoverRecent } from "../../contexts/DiscoverRecentProvider";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useQueueTrackActions } from "../../hooks/useQueueTrackActions";
import { useShareAction } from "../../hooks/useShareAction";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import type { AlbumRouteState } from "../../navigation/albumRoute.tsx";
import { readRouteSeed } from "../../navigation/routeSeed.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  libraryAlbumLookupQueryOptions,
  releaseGroupDetailsQueryOptions,
} from "../../queryOptions.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getReleaseGroupTracks } from "../../utils/api/endpoints/artists.ts";
import { getDownloadStatus } from "../../utils/api/endpoints/library.ts";
import { buildAlbumAddAction, countReleaseTracks } from "../../utils/albumAddAction";
import { favoriteId, firstAvailableFile } from "../../utils/libraryPageData.ts";
import { parseAlbumRef } from "../../../../lib/albumPath.ts";
import {
  buildAlbumHeaderMeta,
  getApiErrorMessage,
  mergeReleaseDetails,
  resolveReleaseLibraryDisplay,
  type ReleaseGroup,
} from "../ArtistDetails/utils";
import { libraryViewQueryOptions } from "../libraryViewQuery.ts";
import { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  Cover,
  EmptyState,
  formatDuration,
  isAlbumArtistCredit,
  trackDurationMs,
  type LibraryRemoval,
  useLibraryScanRefresh,
  useLibraryViewData,
} from "../library/libraryShared.tsx";

import { mergeAlbumTracks } from "./mergeAlbumTracks.ts";
import { useReleasePreviewQueue, useReleaseTracks } from "./releaseTracks.tsx";
import { useAlbumDownload } from "./useAlbumDownload.ts";
import { useLibraryAlbumState } from "./useLibraryAlbumState.ts";
import { useReleaseCover } from "./useReleaseCover.ts";

const LIBRARY_SOURCE = { type: "native-library", id: "library", label: "Library" };

const ACTIVE_DOWNLOAD_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

function AlbumPage() {
  const { ref: routeRef } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locationState: AlbumRouteState | null = location.state || null;
  const { bootstrap, hasPermission } = useAuth();
  const { showError } = useToast();
  const share = useShareAction();
  const { isShuffleEnabled } = useAudioQueue();
  const getQueueItems = useQueueTrackActions();
  const { isDiscoverSectionActive } = useDiscoverRecent();
  const canAddAlbum = hasPermission("addAlbum");
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";

  useLibraryScanRefresh();

  const albumRef = parseAlbumRef(routeRef);
  const routeReleaseGroupMbid = albumRef?.kind === "release" ? albumRef.releaseGroupMbid : null;

  // The library resolves both URL forms (library id or release-group MBID) from its own
  // database, so an owned album never waits on MusicBrainz or Lidarr.
  const libraryQueryOptions = useMemo(
    () => libraryViewQueryOptions({ preview: forcePreview, albumId: routeRef || "none" }),
    [forcePreview, routeRef],
  );
  const libraryQuery = useQuery({
    ...libraryQueryOptions,
    enabled: Boolean(albumRef) && !forcePreview,
  });
  const queryData = libraryQuery.data;
  const { isPreviewLibrary, library, favoriteIds } = useLibraryViewData(queryData, forcePreview);
  const libraryLoading = Boolean(albumRef) && !forcePreview && libraryQuery.isPending;
  const libraryAlbum =
    library.albums.find((album) =>
      albumRef?.kind === "library"
        ? String(album.id) === albumRef.libraryAlbumId
        : album.releaseGroupMbid === routeReleaseGroupMbid || album.mbid === routeReleaseGroupMbid,
    ) || null;

  // Only an album missing from the library asks Lidarr whether it has it or is fetching it
  const albumLookupQuery = useQuery({
    ...libraryAlbumLookupQueryOptions(routeReleaseGroupMbid),
    enabled: Boolean(routeReleaseGroupMbid) && !libraryLoading && !libraryAlbum,
  });
  const lookupEntry = routeReleaseGroupMbid
    ? albumLookupQuery.data?.[routeReleaseGroupMbid]
    : undefined;
  const libraryInfo = !libraryAlbum && lookupEntry?.inLibrary ? lookupEntry : null;

  const handleLibraryEntityRemoved = useCallback(
    (removal: LibraryRemoval) => {
      if (removal.kind === "album" && String(removal.entity.id) === String(libraryAlbum?.id)) {
        navigate("/library/albums" + previewQuery);
      }
    },
    [libraryAlbum?.id, navigate, previewQuery],
  );
  const actions = useLibraryActions({
    libraryQueryKey: libraryQueryOptions.queryKey,
    library,
    favoriteIds,
    isPreviewLibrary,
    forcePreview,
    previewQuery,
    librarySource: LIBRARY_SOURCE,
    onRemoved: handleLibraryEntityRemoved,
  });
  const libraryArtist = libraryAlbum ? actions.getArtistForAlbum(libraryAlbum) || null : null;
  const albumState = useLibraryAlbumState({ libraryAlbum, actions, isPreviewLibrary });
  const albumTracks = albumState.albumTracks;

  // MusicBrainz only adds to the page: missing tracks, previews, type and rating
  // An owned album uses its own release group: the URL may carry a release MBID instead
  const releaseGroupMbid = libraryAlbum
    ? libraryAlbum.releaseGroupMbid || null
    : routeReleaseGroupMbid;
  const routeSeed = readRouteSeed(locationState);
  const focusRelease = locationState?.focusReleaseGroup;
  const baseRelease = useMemo<ReleaseGroup>(
    () => ({
      id: releaseGroupMbid || undefined,
      title: String(focusRelease?.title || "").trim(),
      "first-release-date": focusRelease?.firstReleaseDate || "",
      "primary-type": focusRelease ? focusRelease.primaryType || "Album" : undefined,
      "secondary-types": Array.isArray(focusRelease?.secondaryTypes)
        ? focusRelease.secondaryTypes
        : [],
      rating: focusRelease?.rating || null,
      _coverUrl: focusRelease?.coverUrl || "",
      _deezerAlbumId: focusRelease?.deezerAlbumId || "",
    }),
    [focusRelease, releaseGroupMbid],
  );
  const releaseDetailsQuery = useQuery(releaseGroupDetailsQueryOptions(releaseGroupMbid));
  const release = useMemo(
    () => mergeReleaseDetails(baseRelease, releaseDetailsQuery.data),
    [baseRelease, releaseDetailsQuery.data],
  );
  const artistCredits = releaseDetailsQuery.data?.["artist-credit"];
  const creditedArtist = Array.isArray(artistCredits)
    ? artistCredits.find((credit) => credit?.artist?.id === locationState?.artistMbid) ||
      artistCredits[0]
    : null;
  const artistMbid =
    locationState?.artistMbid || libraryArtist?.mbid || creditedArtist?.artist?.id || null;
  const artistName =
    libraryArtist?.name ||
    locationState?.artistName ||
    creditedArtist?.name ||
    routeSeed?.artistName ||
    libraryAlbum?.albumArtist ||
    "";
  const title = libraryAlbum?.title || release.title || routeSeed?.title || "";
  const headerPending = !title && (libraryLoading || releaseDetailsQuery.isPending);

  // An owned album fetches its tracks with the library's details right away; any other
  // album waits for MusicBrainz details. Either way the key never changes mid-load.
  const trackContext = useMemo(
    () =>
      libraryAlbum
        ? {
            artistMbid: libraryArtist?.mbid || locationState?.artistMbid || undefined,
            artistName,
            albumTitle: libraryAlbum.title,
            releaseDate: libraryAlbum.releaseDate || "",
          }
        : {
            artistMbid: artistMbid || undefined,
            artistName,
            albumTitle: release.title || title,
            releaseType: release["primary-type"] || "",
            releaseDate: release["first-release-date"] || "",
            deezerAlbumId: release._deezerAlbumId || "",
          },
    [artistMbid, artistName, libraryAlbum, libraryArtist?.mbid, locationState, release, title],
  );
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(releaseGroupMbid, trackContext),
    queryFn: ({ signal }) =>
      getReleaseGroupTracks(releaseGroupMbid ?? "", { ...trackContext, signal }),
    enabled:
      Boolean(releaseGroupMbid) &&
      !libraryLoading &&
      Boolean(libraryAlbum || !releaseDetailsQuery.isPending),
    staleTime: 5 * 60 * 1000,
  });
  const releaseTracks = useMemo(
    () => (Array.isArray(tracksQuery.data) ? tracksQuery.data : []),
    [tracksQuery.data],
  );
  const tracksLoading = Boolean(releaseGroupMbid) && tracksQuery.isPending;

  useEffect(() => {
    if (tracksQuery.error && !albumTracks.length) showError("Failed to load tracks");
  }, [albumTracks.length, showError, tracksQuery.error]);

  const lookupLibraryAlbumId = libraryInfo?.libraryAlbumId
    ? String(libraryInfo.libraryAlbumId)
    : null;
  const { isConnected: downloadStatusWsConnected } = useWebSocketChannel(
    "downloads",
    (msg) => {
      if (msg?.type !== "download_statuses" || !lookupLibraryAlbumId) return;
      const next = msg.statuses?.[lookupLibraryAlbumId];
      if (!next) return;
      queryClient.setQueryData(queryKeys.downloadStatus([lookupLibraryAlbumId]), (current) => ({
        ...(current || {}),
        [lookupLibraryAlbumId]: next,
      }));
      if (next.status === "added") {
        queryClient.invalidateQueries({
          queryKey: queryKeys.libraryAlbumLookup([routeReleaseGroupMbid]),
        });
      }
    },
    { enabled: Boolean(lookupLibraryAlbumId) },
  );
  const downloadStatusQuery = useQuery({
    queryKey: queryKeys.downloadStatus(lookupLibraryAlbumId ? [lookupLibraryAlbumId] : []),
    queryFn: ({ signal }) =>
      getDownloadStatus([lookupLibraryAlbumId], { signal, bypassCache: true }),
    enabled: Boolean(lookupLibraryAlbumId),
    staleTime: 4_000,
    refetchInterval: (currentQuery) => {
      if (
        !lookupLibraryAlbumId ||
        downloadStatusWsConnected ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return false;
      }
      const status = currentQuery.state.data?.[lookupLibraryAlbumId]?.status;
      return ACTIVE_DOWNLOAD_STATUSES.has(String(status)) || status === "failed" ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const downloadStatus =
    (lookupLibraryAlbumId && downloadStatusQuery.data?.[lookupLibraryAlbumId]) || null;

  const libraryDisplay = useMemo(
    () =>
      resolveReleaseLibraryDisplay(
        countReleaseTracks(libraryInfo, releaseTracks.length),
        downloadStatus,
      ),
    [downloadStatus, libraryInfo, releaseTracks.length],
  );
  const releaseDownloading =
    !libraryDisplay.isComplete &&
    (actions.isAlbumDownloading(releaseGroupMbid) ||
      ACTIVE_DOWNLOAD_STATUSES.has(String(downloadStatus?.status)));
  // A monitored Aurral album with no files and a future release date downloads on that
  // date, so nothing on the page offers to download it before then.
  const awaitingRelease =
    !libraryDisplay.isComplete &&
    isAwaitingRelease(
      libraryAlbum
        ? {
            managedBy: libraryAlbum.managedBy,
            monitored: albumState.albumMonitored,
            releaseDate: libraryAlbum.releaseDate,
            trackFileCount: Math.max(
              albumTracks.filter((track) => firstAvailableFile(track)).length,
              Number(actions.albumAvailability(libraryAlbum).available || 0),
            ),
          }
        : (libraryInfo ?? {}),
    );
  const awaitingReleaseDate = libraryAlbum?.releaseDate ?? libraryInfo?.releaseDate;

  const libraryCover = libraryAlbum ? actions.getAlbumCover(libraryAlbum) : "";
  const cover = useReleaseCover({
    releaseGroupMbid,
    seedUrl: release._coverUrl || routeSeed?.coverUrl || "",
    artistName,
    albumTitle: release.title,
    enabled: !libraryLoading && !libraryCover,
  });
  const coverUrl = cover.src;

  const artwork = libraryCover || coverUrl;
  const playbackSource = useMemo(
    () => ({
      type: "release",
      id: releaseGroupMbid || String(libraryAlbum?.id || ""),
      label: title || "Release",
    }),
    [libraryAlbum?.id, releaseGroupMbid, title],
  );
  const preview = useReleasePreviewQueue({
    release,
    trackKey: releaseGroupMbid || undefined,
    tracks: releaseTracks,
    artistName,
    artistMbid,
    artwork,
    playbackSource,
  });
  const releaseRows = useReleaseTracks({
    release,
    trackKey: releaseGroupMbid || undefined,
    artistName,
    artistMbid,
    albumMbid: releaseGroupMbid,
    preview,
    playbackSource,
    albumDownloading: releaseDownloading,
    awaitingRelease,
    ownedTrackMbids: libraryInfo?.ownedTrackMbids,
    playlists: actions,
  });

  const { setLibrary } = actions;
  const { reloadLibraryAlbumTracks, updateAlbumMonitoringState } = albumState;
  const handleLibraryAlbumRequested = useCallback(
    async (managedBy: string) => {
      if (!libraryAlbum) return;
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(libraryAlbum.id)
            ? { ...entry, managedBy: managedBy === "lidarr" ? "lidarr" : "aurral" }
            : entry,
        ),
      }));
      updateAlbumMonitoringState(libraryAlbum.id, { monitored: true });
      await reloadLibraryAlbumTracks();
    },
    [libraryAlbum, reloadLibraryAlbumTracks, setLibrary, updateAlbumMonitoringState],
  );
  const { downloadAlbum, requesting, ownerConflict } = useAlbumDownload({
    releaseGroupMbid,
    albumTitle: title,
    artistMbid,
    artistName,
    libraryAlbum,
    libraryArtist,
    triggerSearch: libraryDisplay.triggerSearch,
    onLibraryAlbumRequested: handleLibraryAlbumRequested,
  });

  const merged = useMemo(
    () =>
      mergeAlbumTracks({
        libraryTracks: albumTracks,
        releaseTracks,
        libraryAlbumId: libraryAlbum?.id ?? null,
        releaseKey: releaseGroupMbid || "release",
      }),
    [albumTracks, libraryAlbum?.id, releaseGroupMbid, releaseTracks],
  );
  const rows: TrackListRow[] = merged.map((entry) => {
    const releaseIndex = entry.releaseTrack ? releaseTracks.indexOf(entry.releaseTrack) : -1;
    if (!entry.libraryTrack) {
      return releaseRows.buildReleaseTrackRow(entry.releaseTrack!, releaseIndex, {
        key: entry.key,
        number: entry.number,
      });
    }
    const track = entry.libraryTrack;
    const row = actions.buildLibraryTrackRow(track, albumTracks.indexOf(track), albumTracks);
    const hasFile = Boolean(firstAvailableFile(track));
    const previewPlayback =
      !hasFile && entry.releaseTrack
        ? releaseRows.previewPlayback(entry.releaseTrack, releaseIndex)
        : null;
    return {
      ...row,
      key: entry.key,
      number: entry.number,
      subtitle: isAlbumArtistCredit(track, libraryArtist) ? null : row.subtitle,
      time: hasFile
        ? row.time
        : formatDuration(trackDurationMs(track)) ||
          formatDuration(entry.releaseTrack?.length) ||
          "—",
      // The small "missing" time style is for the library's "Unavailable" label; here
      // the cell always holds a real duration.
      timeMissing: false,
      ...(previewPlayback?.onPlay ? previewPlayback : {}),
    };
  });
  const trackParam =
    searchParams.get("track") ||
    (locationState?.focusTrackMbid ? String(locationState.focusTrackMbid) : "");
  const highlightKey = trackParam
    ? (merged.find(
        (entry) =>
          entry.key === trackParam ||
          String(entry.libraryTrack?.id ?? "") === trackParam ||
          entry.libraryTrack?.mbid === trackParam ||
          entry.releaseTrack?.mbid === trackParam ||
          entry.releaseTrack?.id === trackParam,
      )?.key ?? null)
    : null;

  const trackCount = Math.max(
    merged.length,
    libraryAlbum ? Number(actions.albumAvailability(libraryAlbum).total || 0) : 0,
  );
  const durationMs = merged.reduce(
    (total, entry) =>
      total +
      (Number(entry.libraryTrack && firstAvailableFile(entry.libraryTrack)?.durationMs) ||
        Number(entry.releaseTrack?.length) ||
        0),
    0,
  );
  const availableCount = libraryAlbum
    ? Math.max(
        merged.filter((entry) => entry.libraryTrack && firstAvailableFile(entry.libraryTrack))
          .length,
        Number(actions.albumAvailability(libraryAlbum).available || 0),
      )
    : libraryInfo
      ? Number(libraryInfo.trackFileCount || 0)
      : null;
  const unmonitoredIcon =
    libraryAlbum && albumState.albumMonitored === false ? (
      <Tooltip content="Not monitored">
        <span
          className="native-library-detail__manager"
          data-unmonitored
          role="img"
          aria-label="Not monitored"
        >
          <EyeOff aria-hidden="true" />
        </span>
      </Tooltip>
    ) : null;
  const meta = buildAlbumHeaderMeta({
    release,
    libraryAlbum,
    trackCount,
    availableCount,
    durationMs,
  });

  useDocumentTitle(title ? (artistName ? `${title} — ${artistName}` : title) : "Album");

  const albumPlayable = albumTracks.some((track) => firstAvailableFile(track));
  const albumIsCurrent =
    actions.matchesSource(LIBRARY_SOURCE) &&
    albumTracks.some((track) => String(track.id) === String(actions.currentTrack?.id));
  const loadAlbumDetail = async () => ({ tracks: albumTracks, lookup: null });

  const showAurralStatus = Boolean(
    libraryAlbum && albumState.albumMonitoring.monitored && !isPreviewLibrary,
  );
  const showLibraryPill =
    !showAurralStatus &&
    Boolean(libraryDisplay.label) &&
    libraryDisplay.kind !== "incomplete" &&
    !(libraryAlbum && libraryDisplay.isComplete);
  // Until we know whether the album is in the library, the release-only actions would
  // flash in and could request an album the library already has.
  const libraryResolving = libraryLoading || (!libraryAlbum && albumLookupQuery.isLoading);
  const showDownload =
    !libraryResolving &&
    (libraryAlbum
      ? albumState.canDownloadLibraryAlbum
      : canAddAlbum && Boolean(releaseGroupMbid) && !libraryDisplay.isComplete);
  const searchInsteadOfDownload = Boolean(
    libraryAlbum && albumState.albumManager === "lidarr" && albumState.albumMonitored,
  );
  const downloadBusy =
    requesting || (libraryAlbum ? albumState.libraryAlbumDownloading : releaseDownloading);
  const albumAddAction = buildAlbumAddAction(
    libraryDisplay.triggerSearch,
    actions.libraryDestination,
    release["first-release-date"],
  );

  const libraryContext = !isDiscoverSectionActive;
  const discoverArtistPath = artistMbid ? `/artist/${encodeURIComponent(artistMbid)}` : null;
  const discoverArtistLinkState = libraryArtist
    ? actions.discoverArtistState(libraryArtist)
    : {
        artistName,
        inLibrary: locationState?.inLibrary,
        libraryArtist: locationState?.libraryArtist,
      };
  const libraryArtistPath = libraryArtist ? actions.libraryArtistPath(libraryArtist) : null;
  const subtitleToLibrary = Boolean(libraryArtistPath && (libraryContext || !discoverArtistPath));
  const subtitle = subtitleToLibrary ? (
    <RouteLink to={libraryArtistPath!} className="native-library-detail__artist">
      {artistName}
    </RouteLink>
  ) : discoverArtistPath ? (
    <Link
      to={discoverArtistPath}
      state={discoverArtistLinkState}
      className="native-library-detail__artist"
    >
      {artistName || (headerPending ? <SkeletonText width="7em" /> : "Artist")}
    </Link>
  ) : (
    <p>{artistName || (headerPending ? <SkeletonText width="7em" /> : "Unknown Artist")}</p>
  );
  const shareRelease = () =>
    share(
      {
        kind: "album",
        albumMbid: releaseGroupMbid,
        artistMbid,
        title,
        artistName,
        tracks: releaseTracks.map((track) => ({
          title: track.title,
          artistName,
          albumTitle: title,
          artistMbid,
          albumMbid: releaseGroupMbid,
          trackMbid: track.mbid,
          releaseMbid: track.releaseMbid,
          durationMs: track.length,
          trackNumber: track.trackNumber,
          discNumber: track.discNumber,
        })),
      },
      title,
    );
  const albumMonitoringMenuItem = albumState.getAlbumMonitoringMenuItem(() =>
    downloadAlbum(albumState.activeManager),
  );
  const menuItems: LibraryMenuItem[] = libraryAlbum
    ? [
        ...actions.collectionQueueItems(loadAlbumDetail, !albumPlayable),
        ...actions.albumMenuItems(libraryAlbum, libraryArtist, {
          lidarrConnected: albumState.activeManager === "lidarr",
          extra: albumMonitoringMenuItem ? [albumMonitoringMenuItem] : [],
        }),
      ]
    : [
        ...getQueueItems(preview.getQueueTracks(), { source: playbackSource }),
        {
          id: "share",
          label: "Share",
          icon: Share,
          disabled: !artistName || !title,
          onSelect: shareRelease,
        },
      ];

  if (!albumRef) {
    return <EmptyState title="Not found" message="This album link is not valid." />;
  }
  // The library answers first. Without a library album, a library id is simply gone, and a
  // release-group MBID needs MusicBrainz for anything to show.
  const failed =
    libraryLoading || libraryAlbum
      ? null
      : albumRef.kind === "library"
        ? libraryQuery
        : releaseDetailsQuery;
  if (failed && (albumRef.kind === "library" || (failed.isError && !title))) {
    const status = asApiError(failed.error)?.response?.status;
    const notFound = !failed.isError || status === 404 || status === 400;
    if (notFound) {
      return (
        <CollectionPage>
          <EmptyState
            title="Not found"
            message={
              albumRef.kind === "library"
                ? "This item is no longer in the Library."
                : "This album doesn’t exist on MusicBrainz."
            }
          />
        </CollectionPage>
      );
    }
    return (
      <div className="search-empty-panel" role="alert">
        <div className="search-empty-panel__icon" aria-hidden="true">
          <AlertCircle />
        </div>
        <h1 className="search-empty-panel__title">Couldn’t load this album</h1>
        <p className="search-empty-panel__message">
          {getApiErrorMessage(failed.error) || "The server didn’t respond. Try again in a moment."}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={failed.isFetching}
          onClick={() => void failed.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <CollectionPage tintSrc={artwork}>
      {actions.renderModals()}
      {albumState.albumMonitoring.dialog}
      {libraryAlbum && bootstrap?.lidarr?.circuitOpen === true && (
        <p className="native-library-notice" role="status">
          Lidarr is unavailable. Showing the last indexed library.
        </p>
      )}
      <CollectionHeader
        cover={
          libraryCover ? (
            <Cover src={libraryCover} label={title} thumbnail={false} />
          ) : coverUrl ? (
            <img src={coverUrl} alt="" loading="eager" decoding="async" onError={cover.onError} />
          ) : headerPending ? (
            <SkeletonShape className="skeleton-fill" />
          ) : (
            <span className="native-library-cover-fallback" aria-hidden="true">
              {title.trim().charAt(0).toUpperCase() || "—"}
            </span>
          )
        }
        title={headerPending ? <SkeletonText width="8em" /> : title || "Unknown Album"}
        subtitle={subtitle}
        meta={
          headerPending ? (
            <SkeletonText width="11em" />
          ) : (
            <>
              {/* Items never break inside, and each "·" sticks to the item before it,
                  so lines only wrap after a separator. The unmonitored icon rides
                  with the last item instead of wrapping alone. */}
              {meta.map((segment, index) => (
                <Fragment key={segment.text}>
                  {index ? " · " : null}
                  <span className="native-library-detail__meta-item">
                    {segment.partial ? (
                      <span className="native-library-card__status" data-tone="warning">
                        {segment.text}
                        <span className="sr-only"> available</span>
                      </span>
                    ) : (
                      segment.text
                    )}
                    {unmonitoredIcon && index === meta.length - 1 ? (
                      <>
                        {" · "}
                        {unmonitoredIcon}
                      </>
                    ) : null}
                  </span>
                </Fragment>
              ))}
              {meta.length ? null : unmonitoredIcon}
            </>
          )
        }
        status={
          showAurralStatus && libraryAlbum ? (
            <AurralAlbumStatus
              key={libraryAlbum.id}
              album={libraryAlbum}
              artist={libraryArtist}
              canManage={actions.canAddTracks}
              canRetry={albumState.activeManager === "aurral"}
              onChanged={actions.refreshLibraryActivity}
              onSettled={albumState.reloadLibraryAlbumTracks}
            />
          ) : awaitingRelease ? (
            <div className="native-library-album-status" data-tone="scheduled">
              <p className="native-library-album-status__label">
                {formatReleaseWait(awaitingReleaseDate)}
              </p>
            </div>
          ) : null
        }
        actions={
          <>
            {/* Owned files play in full; otherwise the album plays its previews */}
            <CollectionPlayButtons
              {...(albumPlayable
                ? {
                    label: title || "album",
                    isPlaying: albumIsCurrent && actions.isRunning,
                    isShuffleEnabled: albumIsCurrent && isShuffleEnabled,
                    onPlay: () =>
                      albumIsCurrent ? actions.togglePlayPause() : actions.playTracks(albumTracks),
                    onShuffle: () => actions.playTracks(albumTracks, null, true),
                  }
                : {
                    label: `${title || "Release"} previews`,
                    disabled: libraryResolving || preview.disabled,
                    isPlaying: preview.isListPlaying,
                    isShuffleEnabled: preview.isShuffleEnabled,
                    onPlay: preview.handlePlayAll,
                    onShuffle: preview.handleShufflePlay,
                  })}
            />
            {libraryAlbum ? (
              <FavoriteButton
                active={favoriteIds.has(favoriteId("album", libraryAlbum))}
                pending={Boolean(actions.pendingFavorite)}
                label={title || "album"}
                onClick={() => actions.toggleFavorite("album", libraryAlbum)}
              />
            ) : null}
            {awaitingRelease ? (
              <ReleaseWaitBadge releaseDate={awaitingReleaseDate} />
            ) : showDownload ? (
              <AddActionButton
                {...albumAddAction}
                label={searchInsteadOfDownload ? "Search for album" : albumAddAction.label}
                icon={searchInsteadOfDownload ? Search : albumAddAction.icon}
                ownerConflict={ownerConflict}
                onAdd={(managedBy) => void downloadAlbum(managedBy)}
                isLoading={downloadBusy}
                loadingLabel="Downloading"
                disabled={downloadBusy}
              />
            ) : null}
            {showLibraryPill ? (
              <Tooltip content={libraryDisplay.label}>
                <span className="release-page__library-status">
                  <span>{libraryDisplay.label}</span>
                </span>
              </Tooltip>
            ) : null}
            <LibraryItemMenu
              label={title || "Album"}
              {...(libraryAlbum ? actions.albumMenuProps(libraryAlbum, loadAlbumDetail) : {})}
              items={menuItems}
            />
          </>
        }
      />
      {rows.length ? (
        <TrackList
          label={`${title || "Album"} tracks`}
          rows={rows}
          variant="release"
          highlightKey={highlightKey}
        />
      ) : libraryLoading || tracksLoading ? (
        <SkeletonStatus label="Loading tracks">
          <SkeletonTrackList count={12} variant="release" />
        </SkeletonStatus>
      ) : (
        <div className="native-library-state">
          <span>No tracks available</span>
        </div>
      )}
    </CollectionPage>
  );
}

export default AlbumPage;
