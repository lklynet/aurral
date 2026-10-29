import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ReleaseGroupTrack } from "../../utils/api/endpoints/artists.ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getArtistCover,
  getArtistDetails,
  getArtistPreview,
  getSimilarArtistsForArtist,
  updateArtistOverrides,
} from "../../utils/api/endpoints/artists.ts";
import {
  downloadTrackToLibrary,
  lookupArtistInLibrary,
} from "../../utils/api/endpoints/library.ts";
import { parseResponse } from "hono/client";
import { artistsClient } from "../../utils/api/clients/artists.ts";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import {
  buildStaticPlaylistTrackPayload,
  buildTasteArtist,
  getApiErrorMessage,
  getArtistHeroImage,
  getCoverImage,
  reserveUniquePlaylistName,
} from "./utils";
import { useArtworkWash } from "../../utils/imageColors";
import { useArtistTasteFeedback } from "../../hooks/useArtistTasteFeedback";
import { useStaticPlaylists } from "../../hooks/useStaticPlaylists";

import { useParams, useLocation } from "react-router";
import { useDiscoverNavigation } from "../../hooks/useDiscoverNavigation";
import { AlertCircle, X } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { normalizeMediaUrl } from "../../utils/normalizeMediaUrl";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useModalDialog } from "../../hooks/useModalDialog.ts";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { usePreviewPlayer } from "./hooks/usePreviewPlayer";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { useArtistSearchFocus } from "./hooks/useArtistSearchFocus";
import { ARTIST_DETAILS_APPEARS_ON_LIMIT, allReleaseTypes } from "./constants";
import { ArtistDetailsHero } from "./components/ArtistDetailsHero";
import { ArtistDetailsActionBar } from "./components/ArtistDetailsActionBar";
import { ArtistDetailsDownloadTargets } from "./components/ArtistDetailsDownloadTargets";
import { ArtistDetailsLibraryAlbums } from "./components/ArtistDetailsLibraryAlbums";
import { ArtistDetailsReleaseGroups } from "./components/ArtistDetailsReleaseGroups";
import { ArtistDetailsAppearsOn } from "./components/ArtistDetailsAppearsOn";
import { ArtistDetailsPreviewTracks } from "./components/ArtistDetailsPreviewTracks";
import { ArtistDetailsAbout } from "./components/ArtistDetailsAbout";
import { ArtistDetailsSimilar } from "./components/ArtistDetailsSimilar";
import { DeleteAlbumModal } from "./components/DeleteAlbumModal";
import { AddArtistCustomizeModal } from "./components/AddArtistCustomizeModal";
import { useLibraryDestination } from "../../hooks/useLibraryDestination";
import { queryKeys } from "../../queryClient.ts";
import TooltipButton from "../../components/TooltipButton";
import CrossViewLink from "../../components/CrossViewLink";
import RouteLink from "../../components/RouteLink";
import type { PlaylistSelection, PlaylistTrackIdentity } from "./components/TrackPlaylistMenu";
import type { ArtistPreviewTrack } from "./hooks/usePreviewPlayer";
import type { ReleaseGroup } from "./utils";
import type { ArtistFeedbackSource } from "../../utils/artistTaste.ts";
const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const { state: locationState } = useLocation();
  const navigate = useDiscoverNavigation();
  const artistNameFromNav = locationState?.artistName;
  const initialLibraryHint = useMemo(
    () => ({
      existsInLibrary:
        typeof locationState?.inLibrary === "boolean" ? locationState.inLibrary : undefined,
      libraryArtist: locationState?.libraryArtist || null,
    }),
    [locationState?.inLibrary, locationState?.libraryArtist],
  );
  const { showSuccess, showError, showInfo } = useToast();
  const libraryDestination = useLibraryDestination();
  const { hasPermission } = useAuth();
  const similarArtistsScrollRef = useRef(null);
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [libraryTrackSavingKeys, setLibraryTrackSavingKeys] = useState(() => new Set<string>());
  const [visibleReleaseGroupCoverIds, setVisibleReleaseGroupCoverIds] = useState<string[]>([]);
  const [visibleAppearsOnCoverIds, setVisibleAppearsOnCoverIds] = useState<string[]>([]);
  const [visibleLibraryCoverIds, setVisibleLibraryCoverIds] = useState<string[]>([]);

  const artistOverridesQuery = useQuery({
    queryKey: queryKeys.artistOverrides(mbid),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].overrides.$get(
          { param: { mbid: encodeURIComponent(mbid ?? "") } },
          { init: { signal } },
        ),
      ),
    enabled: false,
    staleTime: 30_000,
  });
  const saveArtistOverridesMutation = useMutation({
    mutationFn: ({
      artistMbid,
      values,
    }: {
      artistMbid: string;
      values: Parameters<typeof updateArtistOverrides>[1];
    }) => updateArtistOverrides(artistMbid, values),
  });
  const downloadTrackMutation = useMutation({ mutationFn: downloadTrackToLibrary });
  const { mutateAsync: saveArtistOverrides } = saveArtistOverridesMutation;
  const { mutateAsync: downloadTrack } = downloadTrackMutation;
  const idsLoading = artistOverridesQuery.isFetching;
  const idsSaving = saveArtistOverridesMutation.isPending;

  const stream = useArtistDetailsStream(mbid, artistNameFromNav, {
    visibleCoverIds: [
      ...visibleReleaseGroupCoverIds,
      ...visibleAppearsOnCoverIds,
      ...visibleLibraryCoverIds,
    ],
    initialLibraryHint,
    appearsOnLimit: ARTIST_DETAILS_APPEARS_ON_LIMIT,
    seedImage:
      typeof locationState?.artistImage === "string"
        ? normalizeMediaUrl(locationState.artistImage) || null
        : null,
  });
  const canAddArtist = hasPermission("addArtist");
  const {
    lookup: artistFeedbackLookup,
    getFeedbackFlags,
    submitFeedback,
  } = useArtistTasteFeedback();
  type TasteAction = keyof ReturnType<typeof getFeedbackFlags>;
  const [tasteActionPending, setTasteActionPending] = useState<TasteAction | null>(null);
  const canAddAlbum = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const {
    artist,
    coverImages,
    setCoverImages,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    similarArtists,
    setSimilarArtists,
    error,
    setLoadingCover,
    loadingSimilar,
    setLoadingSimilar,
    loadingLibrary,
    loadingReleases,
    loadingAppearsOn,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    fulfilledCoverIds,
    setAlbumCovers,
    setArtist,
  } = stream;

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(artistDisplayName);

  const tasteArtist = useMemo(
    () =>
      buildTasteArtist({
        id: artist?.id || mbid,
        name: artistDisplayName,
        tags: artist?.tags,
        genres: artist?.genres,
      }),
    [artist?.genres, artist?.id, artist?.tags, artistDisplayName, mbid],
  );

  const currentArtistFeedback = useMemo(
    () => getFeedbackFlags(tasteArtist),
    [getFeedbackFlags, tasteArtist],
  );

  const handleArtistTasteFeedback = useCallback(
    async (
      targetArtist: ArtistFeedbackSource,
      action: TasteAction,
      { isSelected = false } = {},
    ) => {
      setTasteActionPending(action);
      try {
        return await submitFeedback(targetArtist, action, {
          isSelected,
          sourceContext: "artist_page",
          seedArtistName: tasteArtist.name,
        });
      } finally {
        setTasteActionPending(null);
      }
    },
    [submitFeedback, tasteArtist.name],
  );

  const handleCurrentArtistTasteFeedback = useCallback(
    async (action: TasteAction) => {
      await handleArtistTasteFeedback(tasteArtist, action, {
        isSelected: !!currentArtistFeedback[action],
      });
    },
    [currentArtistFeedback, handleArtistTasteFeedback, tasteArtist],
  );

  const library = useArtistDetailsLibrary({
    artist,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    showSuccess,
    showError,
    showInfo,
    libraryDestination,
  });

  useArtistSearchFocus({
    navigate,
    mbid,
    locationState,
  });

  const libraryLookup = useQuery({
    queryKey: queryKeys.libraryLookupDetails(mbid),
    queryFn: ({ signal }) => lookupArtistInLibrary(mbid, { signal }),
    enabled: false,
  });
  const libraryArtistRecordId = libraryLookup.data?.libraryArtistId || null;
  const lidarrManagesArtist =
    libraryDestination.primary === "lidarr" && libraryArtist?.managedBy !== "aurral";

  const preview = usePreviewPlayer(mbid, artistNameFromNav, artist);
  const {
    previewTracks,
    loadingPreview,
    buildingQueue,
    setLoadingPreview,
    playingPreviewId,
    isArtistPlaybackActive,
    handlePreviewPlay,
    handlePreviewPlayAll,
    setPreviewTracks,
  } = preview;

  const handleOpenEditIds = async () => {
    if (!mbid) return;
    setShowEditIdsModal(true);
    setIdsError("");
    try {
      const { data } = await artistOverridesQuery.refetch({ throwOnError: true });
      setIdsValues({
        musicbrainzId: data?.musicbrainzId || "",
        deezerArtistId: data?.deezerArtistId || "",
      });
    } catch (err) {
      showError(getApiErrorMessage(err) || "Failed to load artist IDs");
    }
  };

  const handleSaveIds = async () => {
    if (!mbid || idsSaving) return;
    const musicbrainzId = idsValues.musicbrainzId.trim();
    const deezerArtistId = idsValues.deezerArtistId.trim();
    if (musicbrainzId && !MBID_REGEX.test(musicbrainzId)) {
      setIdsError("MusicBrainz ID must be a valid UUID.");
      return;
    }
    if (deezerArtistId && !/^\d+$/.test(deezerArtistId)) {
      setIdsError("Deezer artist ID must be numeric.");
      return;
    }
    setIdsError("");
    setLoadingCover(true);
    setLoadingPreview(true);
    setLoadingSimilar(true);
    try {
      await saveArtistOverrides({
        artistMbid: mbid,
        values: {
          musicbrainzId: musicbrainzId || null,
          deezerArtistId: deezerArtistId || null,
        },
      });
      showSuccess("Artist IDs updated");
      setShowEditIdsModal(false);
      const name = artist?.name || artistNameFromNav || "";
      const [details, cover, previewData, similar] = await Promise.all([
        getArtistDetails(mbid, name, { releaseTypes: allReleaseTypes }).catch(() => null),
        getArtistCover(mbid, name, true).catch(() => ({ images: [] })),
        getArtistPreview(mbid, name).catch(() => ({ tracks: [] })),
        getSimilarArtistsForArtist(mbid, name).catch(() => ({ artists: [] })),
      ]);
      if (details?.id) {
        setArtist(details);
      }
      setAlbumCovers({});
      setCoverImages(cover?.images || []);
      setPreviewTracks(previewData?.tracks || []);
      setSimilarArtists(similar?.artists || []);
    } catch (err) {
      showError(getApiErrorMessage(err) || "Failed to update artist IDs");
    } finally {
      setLoadingCover(false);
      setLoadingPreview(false);
      setLoadingSimilar(false);
    }
  };

  const handleCoverError = async () => {
    if (!mbid) return;
    const name = artist?.name || artistNameFromNav || "";
    setLoadingCover(true);
    try {
      const cover = await getArtistCover(mbid, name, true).catch(() => ({
        images: [],
      }));
      setCoverImages(cover?.images || []);
    } finally {
      setLoadingCover(false);
    }
  };

  const getDefaultTrackPlaylistName = (track: PlaylistTrackIdentity | null | undefined) =>
    reserveUniquePlaylistName(
      staticPlaylists,
      `${artist?.name || artistNameFromNav || track?.artistName || "Artist"} Picks`,
    );

  const buildReleaseTrackPayload = (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
  ) => {
    const year = String(releaseGroup?.["first-release-date"] || "").slice(0, 4);
    return buildStaticPlaylistTrackPayload({
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track?.trackName || track?.title || "",
      albumName: releaseGroup?.title || "",
      artistMbid: mbid || "",
      albumMbid: releaseGroup?.id || "",
      releaseMbid: track?.releaseMbid,
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: year,
      durationMs: track?.length,
      trackNumber: track?.trackNumber,
      discNumber: track?.discNumber,
      reason: null,
    });
  };

  const buildPreviewTrackPayload = (track: ArtistPreviewTrack) =>
    buildStaticPlaylistTrackPayload({
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track?.title || track?.trackName || "",
      albumName: track?.album || "",
      artistMbid: mbid || "",
      albumMbid: "",
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: null,
      durationMs: track?.duration_ms,
      reason: "Artist preview",
    });

  const saveTrackToPlaylist = async (
    trackPayload: StaticPlaylistTrackPayload,
    target: PlaylistSelection,
    savingKey: string,
  ) => {
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
        await parseResponse(
          staticPlaylistsClient["shared-playlists"].$post({
            json: {
              name,
              tracks: [trackPayload],
            },
          }),
        );
        showSuccess(`Track saved to ${name}`);
      } else {
        const targetPlaylist = staticPlaylists.find(
          (playlist) => playlist.id === target?.playlistId,
        );
        await parseResponse(
          staticPlaylistsClient["shared-playlists"][":playlistId"].tracks.$post({
            param: { playlistId: encodeURIComponent(target.playlistId) },
            json: {
              tracks: [trackPayload],
            },
          }),
        );
        showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
      }
      const nextPlaylists = await loadStaticPlaylists();
      if (nextPlaylists) {
        setStaticPlaylists(nextPlaylists);
      }
    } catch (err) {
      const message = getApiErrorMessage(err) || "Failed to save track to playlist";
      setPlaylistModalError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
    }
  };

  const handleReleaseTrackAdd = (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
    target: PlaylistSelection,
  ) => {
    const payload = buildReleaseTrackPayload(track, releaseGroup);
    const savingKey = String(track?.id ?? track?.mbid ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  const handlePreviewTrackAdd = (track: ArtistPreviewTrack, target: PlaylistSelection) => {
    const payload = buildPreviewTrackPayload(track);
    const savingKey = String(track?.id ?? track?.title ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  const handleTrackAddToLibrary = async (
    track: ArtistPreviewTrack,
    releaseGroup: ReleaseGroup | null = null,
    trackKey: string | null = null,
  ) => {
    const payload = releaseGroup
      ? buildReleaseTrackPayload(track, releaseGroup)
      : buildPreviewTrackPayload(track);
    if (!payload?.artistName || !payload?.trackName) {
      showError("Track details are incomplete");
      return false;
    }
    const savingKey = String(trackKey ?? track?.id ?? track?.mbid ?? track?.title ?? "");
    if (!savingKey) return false;
    setLibraryTrackSavingKeys((current) => new Set(current).add(savingKey));
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
      showError(getApiErrorMessage(err) || "Failed to add track to library");
    } finally {
      setLibraryTrackSavingKeys((current) => {
        const next = new Set(current);
        next.delete(savingKey);
        return next;
      });
    }
  };

  const heroWash = useArtworkWash(getArtistHeroImage(coverImages));

  if (error) {
    return (
      <div className="search-empty-panel" role="alert">
        <div className="search-empty-panel__icon" aria-hidden="true">
          <AlertCircle />
        </div>
        <h2 className="search-empty-panel__title">Couldn’t load this artist</h2>
        <p className="search-empty-panel__message">{error}</p>
        <RouteLink to="/search" className="btn btn-secondary">
          Back to search
        </RouteLink>
      </div>
    );
  }

  if (!artist) {
    return null;
  }

  const artistCoverImage = getCoverImage(coverImages);
  const playbackSource = {
    type: "artist",
    id: mbid!,
    label: artistDisplayName,
  } as const;

  return (
    <div
      className="artist-details-page"
      style={
        heroWash
          ? {
              "--artwork-wash": `light-dark(${heroWash.light}, ${heroWash.dark})`,
              "--artwork-wash-dark": heroWash.dark,
            }
          : undefined
      }
    >
      <ArtistDetailsHero
        artist={artist}
        coverImages={coverImages}
        onCoverError={handleCoverError}
      />

      <ArtistDetailsActionBar
        library={library}
        mbid={mbid!}
        artistName={artist?.name || artistNameFromNav || ""}
        existsInLibrary={existsInLibrary}
        libraryLink={
          libraryArtistRecordId ? (
            <CrossViewLink
              view="library"
              to={`/library/artist/${encodeURIComponent(libraryArtistRecordId)}`}
            />
          ) : null
        }
        loadingLibrary={loadingLibrary}
        canChangeMonitoring={canChangeMonitoring}
        canAddArtist={canAddArtist}
        canRefreshArtist={canChangeMonitoring && lidarrManagesArtist}
        buildingQueue={buildingQueue}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlayAll={handlePreviewPlayAll}
        onEditIds={handleOpenEditIds}
        onTasteFeedback={handleCurrentArtistTasteFeedback}
        tasteFeedbackUsed={currentArtistFeedback}
        tasteActionPending={tasteActionPending}
      />

      <ArtistDetailsPreviewTracks
        mbid={mbid!}
        artistName={artist?.name || artistNameFromNav || ""}
        loadingPreview={loadingPreview}
        previewTracks={previewTracks}
        playingPreviewId={playingPreviewId}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlay={handlePreviewPlay}
        onAddTrackToPlaylist={handlePreviewTrackAdd}
        onAddTrackToLibrary={handleTrackAddToLibrary}
        libraryTrackSavingKeys={libraryTrackSavingKeys}
        resolveMembershipTrack={buildPreviewTrackPayload}
        playlists={staticPlaylists}
        playlistsLoading={playlistModalLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistError={playlistModalError}
        getDefaultPlaylistName={getDefaultTrackPlaylistName}
        onLoadPlaylists={loadStaticPlaylists}
      />

      <ArtistDetailsDownloadTargets
        releaseGroups={artist?.["release-groups"] || []}
        getAlbumStatus={library.getAlbumStatus}
        artist={artist}
        albumCovers={albumCovers}
        fulfilledCoverIds={fulfilledCoverIds}
        artistCoverImage={artistCoverImage}
        canAddAlbum={canAddAlbum}
        requestingAlbum={library.requestingAlbum}
        handleRequestAlbum={library.handleRequestAlbum}
        libraryDestination={libraryDestination}
        playbackSource={playbackSource}
        artistName={artistDisplayName}
        onAddTrackToPlaylist={handleReleaseTrackAdd}
        onAddTrackToLibrary={handleTrackAddToLibrary}
        libraryTrackSavingKeys={libraryTrackSavingKeys}
        resolveMembershipTrack={buildReleaseTrackPayload}
        playlists={staticPlaylists}
        playlistsLoading={playlistModalLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistError={playlistModalError}
        getDefaultPlaylistName={getDefaultTrackPlaylistName}
        onLoadPlaylists={loadStaticPlaylists}
      />

      {existsInLibrary && libraryAlbums && libraryAlbums.length > 0 && (
        <ArtistDetailsLibraryAlbums
          artist={artist}
          libraryAlbums={libraryAlbums}
          downloadStatuses={library.downloadStatuses}
          requestingAlbum={library.requestingAlbum}
          reSearchingAlbum={library.reSearchingAlbum}
          reSearchingMissingAlbums={library.reSearchingMissingAlbums}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          albumDropdownOpen={library.albumDropdownOpen}
          setAlbumDropdownOpen={library.setAlbumDropdownOpen}
          canDeleteAlbum={canDeleteAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          canReSearchAlbum={canAddAlbum}
          lidarrConnected={libraryDestination.primary === "lidarr"}
          handleReSearchAlbum={library.handleReSearchAlbum}
          handleReSearchMissingDownloads={library.handleReSearchMissingDownloads}
          onVisibleCoverIdsChange={setVisibleLibraryCoverIds}
          artistName={artistDisplayName}
        />
      )}

      {(loadingReleases || (artist["release-groups"] && artist["release-groups"].length > 0)) && (
        <ArtistDetailsReleaseGroups
          artist={artist}
          loadingReleases={loadingReleases}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          libraryDestination={libraryDestination}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          onVisibleCoverIdsChange={setVisibleReleaseGroupCoverIds}
          viewAllLink={{
            to: `/artist/${artist.id}/albums`,
            state: { artistName: artist.name, inLibrary: existsInLibrary },
          }}
        />
      )}

      {(loadingAppearsOn ||
        (artist["appears-on-release-groups"] &&
          artist["appears-on-release-groups"].length > 0)) && (
        <ArtistDetailsAppearsOn
          artist={artist}
          loadingAppearsOn={loadingAppearsOn}
          albumCovers={albumCovers}
          fulfilledCoverIds={fulfilledCoverIds}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          libraryDestination={libraryDestination}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          onVisibleCoverIdsChange={setVisibleAppearsOnCoverIds}
          viewAllLink={{
            to: `/artist/${artist.id}/appears-on`,
            state: { artistName: artist.name, inLibrary: existsInLibrary },
          }}
        />
      )}

      <ArtistDetailsAbout
        artist={artist}
        libraryArtist={libraryArtist}
        appSettings={appSettings}
        lidarrConnected={lidarrManagesArtist}
        existsInLibrary={existsInLibrary}
        coverImages={coverImages}
      />

      {(loadingSimilar || similarArtists.length > 0) && (
        <ArtistDetailsSimilar
          loadingSimilar={loadingSimilar}
          similarArtists={similarArtists}
          similarArtistsScrollRef={similarArtistsScrollRef}
          onArtistFeedback={handleArtistTasteFeedback}
          artistFeedbackLookup={artistFeedbackLookup}
        />
      )}

      <DeleteAlbumModal
        show={!!library.showDeleteAlbumModal}
        title={library.showDeleteAlbumModal?.title}
        managedBy={library.showDeleteAlbumModal?.managedBy}
        keepFilesAction="unmonitor"
        deleteFiles={library.deleteAlbumFiles}
        onDeleteFilesChange={library.setDeleteAlbumFiles}
        onCancel={library.handleDeleteAlbumCancel}
        onConfirm={library.handleDeleteAlbumConfirm}
        removing={Boolean(library.removingAlbum)}
      />

      <AddArtistCustomizeModal
        error={library.customizeAddError}
        show={library.showAddCustomizeModal}
        artistName={artist?.name}
        loading={library.loadingLidarrPreferences}
        preferences={library.lidarrPreferences}
        rootFolderPath={library.customizeRootFolderPath}
        setRootFolderPath={library.setCustomizeRootFolderPath}
        qualityProfileId={library.customizeQualityProfileId}
        setQualityProfileId={library.setCustomizeQualityProfileId}
        tagId={library.customizeTagId}
        setTagId={library.setCustomizeTagId}
        monitorOption={library.customizeMonitorOption}
        setMonitorOption={library.setCustomizeMonitorOption}
        onClose={() => library.setShowAddCustomizeModal(false)}
        onConfirm={library.handleCustomizeAddToLibrary}
        confirming={library.addingToLibrary}
      />

      <EditArtistIdsModal
        show={showEditIdsModal}
        loading={idsLoading}
        saving={idsSaving}
        values={idsValues}
        error={idsError}
        artistName={artist?.name}
        onChange={setIdsValues}
        onClose={() => setShowEditIdsModal(false)}
        onSave={handleSaveIds}
      />
    </div>
  );
}

export default ArtistDetailsPage;

type StaticPlaylistTrackPayload = ReturnType<typeof buildStaticPlaylistTrackPayload>;

type EditArtistIdsModalProps = {
  show: boolean;
  loading: boolean;
  saving: boolean;
  values: { musicbrainzId: string; deezerArtistId: string };
  error: string;
  artistName: string | undefined;
  onChange: Dispatch<SetStateAction<{ musicbrainzId: string; deezerArtistId: string }>>;
  onClose: () => void;
  onSave: () => void;
};

function EditArtistIdsModal({
  show,
  loading,
  saving,
  values,
  error,
  artistName,
  onChange,
  onClose,
  onSave,
}: EditArtistIdsModalProps) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: show,
    onClose,
    closeDisabled: saving,
  });

  if (!show) return null;
  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <h3 id={titleId} className="artist-modal__title">
            Edit artist IDs
          </h3>
          <TooltipButton
            type="button"
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>
        {artistName ? <p className="artist-modal__subcopy">{artistName}</p> : null}
        <div className="artist-modal__fields">
          <div>
            <label className="artist-field-label">MusicBrainz ID</label>
            <input
              type="text"
              value={values.musicbrainzId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  musicbrainzId: e.target.value,
                }))
              }
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="artist-input"
            />
          </div>
          <div>
            <label className="artist-field-label">Deezer artist ID</label>
            <input
              type="text"
              value={values.deezerArtistId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  deezerArtistId: e.target.value,
                }))
              }
              placeholder="Numeric Deezer ID"
              className="artist-input"
            />
          </div>
          <p className="artist-subtext">Leave both fields blank to clear overrides.</p>
          {error && <div className="artist-error-text">{error}</div>}
        </div>
        <div className="artist-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={loading || saving}
          >
            {saving ? <DotLoader size="sm" label={null} /> : null}
            {saving ? "Saving..." : "Save IDs"}
          </button>
        </div>
      </div>
    </div>
  );
}
