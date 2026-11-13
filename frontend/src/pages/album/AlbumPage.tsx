import { Fragment, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertCircle, EyeOff, Share } from "../../components/icons";
import AddActionButton from "../../components/AddActionButton";
import { formatReleaseWait, isAwaitingRelease } from "../../utils/albumStatus.ts";
import { AlbumDownloadStatus, AlbumEditionNote } from "../../components/AlbumDownloadStatus";
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
import { readAlbumRouteState } from "../../navigation/albumRoute.tsx";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  libraryAlbumLookupQueryOptions,
  releaseGroupDetailsQueryOptions,
} from "../../queryOptions.ts";
import { asApiError } from "../../utils/api/core.ts";
import {
  getReleaseTrackCredits,
  type ReleaseGroupTrack,
} from "../../utils/api/endpoints/artists.ts";
import { useReleaseGroupTracks } from "../../hooks/useReleaseGroupTracks.ts";
import { formatArtistCredit } from "../../../../lib/artistCredit.ts";
import { buildAlbumAddAction, countReleaseTracks } from "../../utils/albumAddAction";
import { favoriteId, firstAvailableFile } from "../../utils/libraryPageData.ts";
import { parseAlbumRef } from "../../../../lib/albumPath.ts";
import {
  buildAlbumHeaderMeta,
  mergeReleaseDetails,
  resolveReleaseLibraryDisplay,
  type ReleaseGroup,
} from "../ArtistDetails/utils";
import { libraryViewQueryOptions } from "../../utils/libraryViewQuery.ts";
import { LIBRARY_SOURCE, useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  Cover,
  formatDuration,
  isAlbumArtistCredit,
  trackDurationMs,
  type LibraryRemoval,
  useLibraryScanRefresh,
  useLibraryViewData,
} from "../library/libraryShared.tsx";

import { albumDiscHeadings, mergeAlbumTracks } from "./mergeAlbumTracks.ts";
import { OwnedTrackMark, useReleasePreviewQueue, useReleaseTracks } from "./releaseTracks.tsx";
import { useAlbumDownload } from "./useAlbumDownload.ts";
import { useLibraryAlbumState } from "./useLibraryAlbumState.ts";
import { useReleaseCover } from "./useReleaseCover.ts";
import { useAlbumEditions } from "./useAlbumEditions.tsx";
import StatePanel from "../../components/StatePanel";
import { getApiErrorMessage } from "../../utils/api/errors.ts";

function AlbumPage() {
  const { ref: routeRef } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locationState = useMemo(() => readAlbumRouteState(location.state), [location.state]);
  const { hasPermission } = useAuth();
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
    onRemoved: handleLibraryEntityRemoved,
  });
  const libraryArtist = libraryAlbum ? actions.getArtistForAlbum(libraryAlbum) || null : null;
  const albumState = useLibraryAlbumState({ libraryAlbum, actions, isPreviewLibrary });
  const albumTracks = albumState.albumTracks;

  const releaseGroupMbid = libraryAlbum
    ? libraryAlbum.releaseGroupMbid || null
    : routeReleaseGroupMbid;
  const routeSeed = locationState.seed ?? null;
  const focusRelease = locationState?.focusReleaseGroup;
  const baseRelease = useMemo<ReleaseGroup>(
    () => ({
      id: releaseGroupMbid || undefined,
      title: String(focusRelease?.title || libraryAlbum?.title || "").trim(),
      "first-release-date": focusRelease?.firstReleaseDate || libraryAlbum?.releaseDate || "",
      "primary-type": focusRelease ? focusRelease.primaryType || "Album" : undefined,
      "secondary-types": Array.isArray(focusRelease?.secondaryTypes)
        ? focusRelease.secondaryTypes
        : [],
      rating: focusRelease?.rating || null,
      _coverUrl: focusRelease?.coverUrl || "",
      _deezerAlbumId: focusRelease?.deezerAlbumId || "",
    }),
    [focusRelease, libraryAlbum?.releaseDate, libraryAlbum?.title, releaseGroupMbid],
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
  const editions = useAlbumEditions({
    releaseGroupMbid,
    libraryAlbumId: libraryAlbum?.id ?? null,
    enabled: !libraryLoading,
    canChoose: canAddAlbum,
    onChosen: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: libraryQueryOptions.queryKey }),
        albumState.reloadLibraryAlbumTracks(),
      ]),
  });
  const previewingLibraryEdition = Boolean(editions.note);
  const title =
    (editions.visible && release.title) ||
    libraryAlbum?.title ||
    release.title ||
    routeSeed?.title ||
    "";
  const headerPending = !title && (libraryLoading || releaseDetailsQuery.isPending);

  const {
    tracks: releaseTracks,
    isPending: tracksLoading,
    error: tracksError,
  } = useReleaseGroupTracks(releaseGroupMbid, {
    artistMbid: locationState?.artistMbid || undefined,
    deezerAlbumId: focusRelease?.deezerAlbumId ? String(focusRelease.deezerAlbumId) : undefined,
    release: editions.previewRelease,
  });

  useEffect(() => {
    if (tracksError && !albumTracks.length && !releaseDetailsQuery.isError) {
      showError("Failed to load tracks");
    }
  }, [albumTracks.length, releaseDetailsQuery.isError, showError, tracksError]);

  const libraryDisplay = resolveReleaseLibraryDisplay(
    countReleaseTracks(libraryInfo, releaseTracks.length),
  );
  const releaseDownloading =
    !libraryDisplay.isComplete && actions.isAlbumDownloading(releaseGroupMbid);
  const availability = libraryAlbum ? actions.albumAvailability(libraryAlbum) : null;
  const libraryFileCount = Math.max(
    albumTracks.filter((track) => firstAvailableFile(track)).length,
    Number(availability?.available || 0),
  );
  const awaitingRelease =
    !libraryDisplay.isComplete &&
    isAwaitingRelease(
      libraryAlbum
        ? {
            managed: libraryAlbum.managed,
            monitored: albumState.albumMonitored,
            releaseDate: libraryAlbum.releaseDate,
            trackFileCount: libraryFileCount,
          }
        : (libraryInfo ?? {}),
    );
  const awaitingReleaseDate = libraryAlbum?.releaseDate ?? libraryInfo?.releaseDate;

  const libraryCover = libraryAlbum?.coverUrl || "";
  const cover = useReleaseCover({
    releaseGroupMbid,
    seedUrl: release._coverUrl || routeSeed?.coverUrl || "",
    artistName,
    albumTitle: release.title,
    enabled: !libraryLoading && !libraryCover,
  });
  const artwork = libraryCover || cover.src;
  const playbackSource = useMemo(
    () => ({
      type: "release",
      id: releaseGroupMbid || String(libraryAlbum?.id || ""),
      label: title || "Release",
    }),
    [libraryAlbum?.id, releaseGroupMbid, title],
  );
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
  const splitEditions = editions.visible && releaseTracks.length > 0;
  const listed = splitEditions ? merged.filter((entry) => entry.releaseTrack) : merged;
  const extras = splitEditions
    ? merged.filter((entry) => !entry.releaseTrack && firstAvailableFile(entry.libraryTrack))
    : [];
  const entries = [...listed, ...extras];
  const hasMissingTracks = merged.some(
    (entry) => !entry.libraryTrack || !firstAvailableFile(entry.libraryTrack),
  );
  const creditsReleaseMbid = hasMissingTracks ? releaseTracks[0]?.releaseMbid : null;
  const { data: releaseCredits } = useQuery({
    queryKey: queryKeys.releaseTrackCredits(creditsReleaseMbid),
    queryFn: ({ signal }) => getReleaseTrackCredits(creditsReleaseMbid ?? "", { signal }),
    enabled: Boolean(creditsReleaseMbid),
    staleTime: 24 * 60 * 60 * 1000,
  });
  const creditFor = useCallback(
    (track: ReleaseGroupTrack) => {
      const credit = track.mbid ? releaseCredits?.credits[track.mbid] : undefined;
      const text = credit ? formatArtistCredit(credit) : "";
      return text && text.toLowerCase() !== artistName.toLowerCase() ? text : null;
    },
    [artistName, releaseCredits],
  );

  const hasReleaseCredit = useCallback(
    (track: ReleaseGroupTrack) => Boolean(track.mbid && releaseCredits?.credits[track.mbid]),
    [releaseCredits],
  );

  const ownedTrackMbids = useMemo(
    () => [
      ...(libraryInfo?.ownedTrackMbids || []),
      ...merged.flatMap((entry) =>
        entry.releaseTrack && entry.libraryTrack && firstAvailableFile(entry.libraryTrack)
          ? [entry.releaseTrack.mbid, entry.releaseTrack.id].filter((id) => id != null)
          : [],
      ),
    ],
    [libraryInfo?.ownedTrackMbids, merged],
  );
  const preview = useReleasePreviewQueue({
    release,
    trackKey: releaseGroupMbid || undefined,
    tracks: releaseTracks,
    artistName,
    artistMbid,
    artwork,
    playbackSource,
    ownedTrackMbids,
    awaitingRelease,
    creditFor,
  });
  const releaseRows = useReleaseTracks({
    release,
    artistName,
    artistMbid,
    preview,
    playbackSource,
    albumDownloading: releaseDownloading,
    playlists: actions,
  });

  const { downloadAlbum, requesting } = useAlbumDownload({
    releaseGroupMbid,
    albumTitle: title,
    artistMbid,
    artistName,
    libraryAlbum,
    libraryArtist,
    releaseMbid: editions.previewRelease,
    onLibraryAlbumRequested: albumState.markAlbumRequested,
  });

  const sections = [
    ...albumDiscHeadings(listed),
    ...extras.map((_, index) => (index ? null : "From other editions")),
  ];
  const rows: TrackListRow[] = entries.map((entry, index) => {
    const { releaseIndex } = entry;
    const section = sections[index];
    if (!entry.libraryTrack) {
      return {
        ...releaseRows.buildReleaseTrackRow(entry.releaseTrack!, releaseIndex, {
          key: entry.key,
          number: entry.number,
        }),
        section,
      };
    }
    const track = entry.libraryTrack;
    const row = actions.buildLibraryTrackRow(track, albumTracks.indexOf(track), albumTracks);
    const hasFile = Boolean(firstAvailableFile(track));
    const previewPlayback =
      !hasFile && entry.releaseTrack
        ? preview.previewPlayback(entry.releaseTrack, releaseIndex)
        : null;
    const previewQueueItems =
      previewPlayback?.onPlay && entry.releaseTrack
        ? getQueueItems(preview.normalizeTrack(entry.releaseTrack, releaseIndex), {
            source: playbackSource,
          })
        : [];
    return {
      ...row,
      section,
      key: entry.key,
      number: entry.releaseTrack || !splitEditions ? entry.number : null,
      subtitle:
        !hasFile && entry.releaseTrack && hasReleaseCredit(entry.releaseTrack)
          ? creditFor(entry.releaseTrack)
          : isAlbumArtistCredit(track, libraryArtist)
            ? null
            : row.subtitle,
      ...(hasFile && hasMissingTracks && { trailing: <OwnedTrackMark /> }),
      time: hasFile
        ? row.time
        : formatDuration(trackDurationMs(track)) ||
          formatDuration(entry.releaseTrack?.length) ||
          "—",
      timeMissing: false,
      ...(previewPlayback?.onPlay && previewPlayback),
      ...(previewQueueItems.length &&
        row.menu && {
          menu: {
            ...row.menu,
            items: [
              ...previewQueueItems,
              ...(row.menu.items || []).filter((item) => item.id !== "play"),
            ],
            additionalItemsAfter: previewQueueItems.at(-1)?.id,
          },
        }),
    };
  });
  const trackParam = searchParams.get("track") || "";
  const highlightKey = trackParam
    ? (entries.find(
        (entry) =>
          entry.key === trackParam ||
          entry.libraryTrack?.mbid === trackParam ||
          entry.releaseTrack?.mbid === trackParam ||
          entry.releaseTrack?.id === trackParam,
      )?.key ?? null)
    : null;

  const trackCount = Math.max(
    listed.length,
    editions.previewRelease ? 0 : Number(availability?.total || 0),
  );
  const durationMs = listed.reduce(
    (total, entry) =>
      total +
      (Number(entry.libraryTrack && firstAvailableFile(entry.libraryTrack)?.durationMs) ||
        Number(entry.releaseTrack?.length) ||
        Number(entry.libraryTrack && trackDurationMs(entry.libraryTrack)) ||
        0),
    0,
  );
  const availableCount = libraryAlbum
    ? libraryFileCount
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
    release: editions.previewRelease
      ? { ...release, "first-release-date": editions.viewing?.date ?? "" }
      : release,
    libraryAlbum,
    trackCount,
    availableCount: editions.previewRelease ? null : availableCount,
    durationMs,
    edition: editions.select ? editions.viewing?.name : null,
  });

  useDocumentTitle(title ? (artistName ? `${title} — ${artistName}` : title) : "Album");

  const albumPlayable = albumTracks.some((track) => firstAvailableFile(track));
  const albumIsCurrent =
    actions.matchesSource(LIBRARY_SOURCE) &&
    albumTracks.some((track) => String(track.id) === String(actions.currentTrack?.id));
  const loadAlbumDetail = async () => ({ tracks: albumTracks, lookup: null });

  const showStatus = Boolean(
    libraryAlbum && albumState.albumMonitoring.monitored && !isPreviewLibrary,
  );
  const showLibraryPill =
    !showStatus &&
    Boolean(libraryDisplay.label) &&
    libraryDisplay.kind !== "incomplete" &&
    !(libraryAlbum && libraryDisplay.isComplete);
  const libraryResolving = libraryLoading || (!libraryAlbum && albumLookupQuery.isLoading);
  const showDownload =
    !libraryResolving &&
    !previewingLibraryEdition &&
    (libraryAlbum
      ? albumState.canDownloadLibraryAlbum(hasMissingTracks)
      : canAddAlbum && Boolean(releaseGroupMbid) && !libraryDisplay.isComplete);
  const downloadBusy =
    requesting || (libraryAlbum ? albumState.libraryAlbumDownloading : releaseDownloading);
  const albumAddAction = buildAlbumAddAction(release["first-release-date"]);

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
  const artistLink = subtitleToLibrary
    ? { to: libraryArtistPath! }
    : discoverArtistPath && { to: discoverArtistPath, state: discoverArtistLinkState };
  const artistLabel =
    artistName || (headerPending ? <SkeletonText width="7em" /> : "Unknown Artist");
  const subtitle = artistLink ? (
    <RouteLink {...artistLink} className="native-library-detail__artist">
      {artistLabel}
    </RouteLink>
  ) : (
    <p>{artistLabel}</p>
  );
  const albumMonitoringMenuItem = albumState.albumMonitoring.menuItem;
  const menuItems: LibraryMenuItem[] = libraryAlbum
    ? [
        ...actions.collectionQueueItems(loadAlbumDetail, !albumPlayable, {
          seed: { albumIds: [String(libraryAlbum.id)] },
          label: libraryAlbum.title || "Album",
        }),
        ...actions.albumMenuItems(libraryAlbum, libraryArtist, {
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
          onSelect: () =>
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
            ),
        },
      ];

  const failed =
    !albumRef || libraryLoading || libraryAlbum
      ? null
      : albumRef.kind === "library"
        ? libraryQuery
        : releaseDetailsQuery;
  if (
    !albumRef ||
    (failed && (albumRef.kind === "library" || (failed.isError && (!title || tracksError))))
  ) {
    const status = asApiError(failed?.error)?.response?.status;
    const notFound = !failed?.isError || status === 404 || status === 400;
    return (
      <StatePanel
        role="alert"
        icon={<AlertCircle />}
        heading="h1"
        title={notFound ? "Not found" : "Couldn’t load this album"}
        message={
          !albumRef
            ? "This album link is not valid."
            : notFound
              ? albumRef.kind === "library"
                ? "This item is no longer in the Library."
                : "This album doesn’t exist on MusicBrainz."
              : getApiErrorMessage(
                  failed?.error,
                  "The server didn’t respond. Try again in a moment.",
                )
        }
        onRetry={notFound ? undefined : () => void failed?.refetch()}
        retrying={failed?.isFetching}
      />
    );
  }

  return (
    <CollectionPage tintSrc={artwork}>
      {actions.renderModals()}
      {albumState.albumMonitoring.dialog}
      <CollectionHeader
        cover={
          !artwork && headerPending ? (
            <SkeletonShape className="skeleton-fill" />
          ) : (
            <Cover
              src={artwork}
              label={title}
              thumbnail={false}
              onError={libraryCover ? undefined : cover.onError}
            />
          )
        }
        title={headerPending ? <SkeletonText width="8em" /> : title || "Unknown Album"}
        subtitle={subtitle}
        meta={
          headerPending ? (
            <SkeletonText width="11em" />
          ) : (
            <>
              {meta.map((segment, index) => (
                <Fragment key={segment.edition ? "edition" : segment.text}>
                  {index ? " · " : null}
                  <span className="native-library-detail__meta-item">
                    {segment.edition ? (
                      editions.select
                    ) : segment.partial ? (
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
          showStatus && libraryAlbum ? (
            <AlbumDownloadStatus
              key={libraryAlbum.id}
              album={libraryAlbum}
              artist={libraryArtist}
              canManage={actions.canAddTracks}
              edition={editions.note}
              onChanged={actions.refreshLibraryActivity}
              onSettled={albumState.reloadLibraryAlbumTracks}
            />
          ) : editions.note ? (
            <AlbumEditionNote edition={editions.note} />
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
                    label: title || "Release",
                    playLabel: libraryResolving ? undefined : "Preview",
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
                onAdd={() => void downloadAlbum()}
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
