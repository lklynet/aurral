import { useCallback, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Loader, Music, X } from "lucide-react";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { usePreviewPlayer } from "./hooks/usePreviewPlayer";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { useArtistSearchFocus } from "./hooks/useArtistSearchFocus";
import { allReleaseTypes, ARTIST_DETAILS_APPEARS_ON_LIMIT } from "./constants";
import { ArtistDetailsHero } from "./components/ArtistDetailsHero";
import { ArtistDetailsActionBar } from "./components/ArtistDetailsActionBar";
import { ArtistDetailsDownloadTargets } from "./components/ArtistDetailsDownloadTargets";
import { ArtistDetailsLibraryAlbums } from "./components/ArtistDetailsLibraryAlbums";
import { ArtistDetailsReleaseGroups } from "./components/ArtistDetailsReleaseGroups";
import { ArtistDetailsAppearsOn } from "./components/ArtistDetailsAppearsOn";
import { ArtistDetailsPreviewTracks } from "./components/ArtistDetailsPreviewTracks";
import { ArtistDetailsAbout } from "./components/ArtistDetailsAbout";
import { ArtistDetailsSimilar } from "./components/ArtistDetailsSimilar";
import { DeleteArtistModal } from "./components/DeleteArtistModal";
import { DeleteAlbumModal } from "./components/DeleteAlbumModal";
import { AddArtistCustomizeModal } from "./components/AddArtistCustomizeModal";
import {
  addArtistToLibrary,
  addSharedPlaylistTracks,
  getArtistCover,
  getArtistDetails,
  getArtistOverrides,
  getArtistPreview,
  getFlowStatus,
  getSimilarArtistsForArtist,
  createSharedPlaylist,
  updateArtistOverrides,
} from "../../utils/api";
import { getArtistPosterImage } from "./utils";
import { useArtistTasteFeedback } from "../../hooks/useArtistTasteFeedback";

const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const { state: locationState } = useLocation();
  const navigate = useNavigate();
  const artistNameFromNav = locationState?.artistName;
  const initialLibraryHint = useMemo(
    () => ({
      existsInLibrary:
        typeof locationState?.inLibrary === "boolean"
          ? locationState.inLibrary
          : undefined,
      libraryArtist: locationState?.libraryArtist || null,
    }),
    [locationState?.inLibrary, locationState?.libraryArtist],
  );
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const similarArtistsScrollRef = useRef(null);
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsLoading, setIdsLoading] = useState(false);
  const [idsSaving, setIdsSaving] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [visibleReleaseGroupCoverIds, setVisibleReleaseGroupCoverIds] = useState(
    [],
  );
  const [visibleAppearsOnCoverIds, setVisibleAppearsOnCoverIds] = useState([]);
  const [visibleLibraryCoverIds, setVisibleLibraryCoverIds] = useState([]);

  const selectedReleaseTypes = allReleaseTypes;

  const stream = useArtistDetailsStream(
    mbid,
    artistNameFromNav,
    selectedReleaseTypes,
    {
      visibleCoverIds: [
        ...visibleReleaseGroupCoverIds,
        ...visibleAppearsOnCoverIds,
        ...visibleLibraryCoverIds,
      ],
      initialLibraryHint,
      appearsOnLimit: ARTIST_DETAILS_APPEARS_ON_LIMIT,
    },
  );
  const canAddArtist = hasPermission("addArtist");
  const { lookup: artistFeedbackLookup, getFeedbackFlags, submitFeedback } =
    useArtistTasteFeedback();
  const [tasteActionPending, setTasteActionPending] = useState(null);
  const canAddAlbum = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const canDeleteArtist = hasPermission("deleteArtist");
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
    loading,
    error,
    loadingCover,
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
    setAlbumCovers,
    setArtist,
  } = stream;

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(artistDisplayName);

  const tasteArtist = useMemo(
    () => ({
      id: artist?.id || mbid,
      name: artistDisplayName,
      tags: artist?.tags || [],
      genres: artist?.genres || [],
    }),
    [artist?.genres, artist?.id, artist?.tags, artistDisplayName, mbid],
  );

  const currentArtistFeedback = useMemo(
    () => getFeedbackFlags(tasteArtist),
    [getFeedbackFlags, tasteArtist],
  );

  const handleArtistTasteFeedback = useCallback(
    async (targetArtist, action, { isSelected = false } = {}) => {
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
    async (action) => {
      await handleArtistTasteFeedback(tasteArtist, action, {
        isSelected: !!currentArtistFeedback[action],
      });
    },
    [currentArtistFeedback, handleArtistTasteFeedback, tasteArtist],
  );

  const handleAddSimilarArtistToLibrary = useCallback(
    async (similarArtist) => {
      const artistId = similarArtist?.id || similarArtist?.mbid;
      if (!similarArtist?.name || !artistId) return false;
      try {
        await addArtistToLibrary({
          foreignArtistId: artistId,
          artistName: similarArtist.name,
        });
        showSuccess(`Adding ${similarArtist.name}...`);
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add artist to library",
        );
        return false;
      }
    },
    [showError, showSuccess],
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
    selectedReleaseTypes,
  });

  useArtistSearchFocus({
    navigate,
    mbid,
    locationState,
  });

  const preview = usePreviewPlayer(mbid, artistNameFromNav, artist, {
    existsInLibrary,
    libraryArtist,
    libraryAlbums,
    downloadStatuses: library.downloadStatuses || {},
  });
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
    setIdsLoading(true);
    try {
      const data = await getArtistOverrides(mbid);
      setIdsValues({
        musicbrainzId: data?.musicbrainzId || "",
        deezerArtistId: data?.deezerArtistId || "",
      });
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to load artist IDs"
      );
    } finally {
      setIdsLoading(false);
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
      setIdsError("Deezer Artist ID must be numeric.");
      return;
    }
    setIdsSaving(true);
    setIdsError("");
    setLoadingCover(true);
    setLoadingPreview(true);
    setLoadingSimilar(true);
    try {
      await updateArtistOverrides(mbid, {
        musicbrainzId: musicbrainzId || null,
        deezerArtistId: deezerArtistId || null,
      });
      showSuccess("Artist IDs updated");
      setShowEditIdsModal(false);
      const name = artist?.name || artistNameFromNav || "";
      const [details, cover, previewData, similar] = await Promise.all([
        getArtistDetails(mbid, name, {
          releaseTypes: selectedReleaseTypes,
        }).catch(() => null),
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
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update artist IDs"
      );
    } finally {
      setLoadingCover(false);
      setLoadingPreview(false);
      setLoadingSimilar(false);
      setIdsSaving(false);
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

  const loadSharedPlaylists = async () => {
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
  };

  const getDefaultTrackPlaylistName = (track) =>
    reserveUniquePlaylistName(
      sharedPlaylists,
      `${artist?.name || artistNameFromNav || track?.artistName || "Artist"} Picks`,
    );

  const buildReleaseTrackPayload = (track, releaseGroup) => {
    const year = String(releaseGroup?.["first-release-date"] || "").slice(0, 4);
    return {
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track?.trackName || track?.title || "",
      albumName: releaseGroup?.title || "",
      artistMbid: mbid || "",
      albumMbid: releaseGroup?.id || "",
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: year || null,
      durationMs:
        track?.length != null && Number.isFinite(Number(track.length))
          ? Number(track.length)
          : null,
      reason: null,
      artistAliases: [],
    };
  };

  const buildPreviewTrackPayload = (track) => ({
    artistName: artist?.name || artistNameFromNav || "",
    trackName: track?.title || track?.trackName || "",
    albumName: track?.album || "",
    artistMbid: mbid || "",
    albumMbid: "",
    trackMbid: track?.mbid || track?.id || "",
    releaseYear: null,
    durationMs:
      track?.duration_ms != null && Number.isFinite(Number(track.duration_ms))
        ? Number(track.duration_ms)
        : null,
    reason: "Artist preview",
    artistAliases: [],
  });

  const saveTrackToPlaylist = async (trackPayload, target, savingKey) => {
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
        showSuccess(
          `Track saved to ${response?.playlist?.name || name}`,
        );
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (playlist) => playlist.id === target?.playlistId,
        );
        await addSharedPlaylistTracks(target.playlistId, {
          tracks: [trackPayload],
        });
        showSuccess(
          `Track added to ${targetPlaylist?.name || "playlist"}`,
        );
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
  };

  const handleReleaseTrackAdd = (track, releaseGroup, target) => {
    const payload = buildReleaseTrackPayload(track, releaseGroup);
    const savingKey = String(track?.id ?? track?.mbid ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  const handlePreviewTrackAdd = (track, target) => {
    const payload = buildPreviewTrackPayload(track);
    const savingKey = String(track?.id ?? track?.title ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  if (loading) {
    return (
      <div className="artist-loading">
        <Loader className="artist-spinner artist-spinner--large animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="artist-error-panel">
        <div>
          <Music className="artist-error-icon" />
          <h3 className="artist-error-title">
            Error Loading Artist
          </h3>
          <p className="artist-error-copy">
            {error}
          </p>
          <button
            onClick={() => navigate("/search")}
            className="btn btn-primary artist-hidden-mobile"
          >
            Back to Search
          </button>
        </div>
      </div>
    );
  }

  if (!artist) {
    return null;
  }

  const artistCoverImage = getArtistPosterImage(coverImages);
  const playbackSource = {
    type: "artist",
    id: mbid,
    label: artistDisplayName,
  };

  return (
    <div className="artist-details-page">
      <ArtistDetailsHero
        artist={artist}
        coverImages={coverImages}
        loadingCover={loadingCover}
        loadingLibrary={loadingLibrary}
        existsInLibrary={existsInLibrary}
        onCoverError={handleCoverError}
        onNavigate={(path) => navigate(path)}
      />

      <ArtistDetailsActionBar
        existsInLibrary={existsInLibrary}
        loadingLibrary={loadingLibrary}
        showRemoveDropdown={library.showRemoveDropdown}
        setShowRemoveDropdown={library.setShowRemoveDropdown}
        showMonitorOptionMenu={library.showMonitorOptionMenu}
        setShowMonitorOptionMenu={library.setShowMonitorOptionMenu}
        updatingMonitor={library.updatingMonitor}
        canChangeMonitoring={canChangeMonitoring}
        getCurrentMonitorOption={library.getCurrentMonitorOption}
        handleUpdateMonitorOption={library.handleUpdateMonitorOption}
        canDeleteArtist={canDeleteArtist}
        handleDeleteClick={library.handleDeleteClick}
        canAddArtist={canAddArtist}
        handleAddToLibrary={library.handleAddToLibrary}
        handleOpenAddCustomizeModal={library.handleOpenAddCustomizeModal}
        addingToLibrary={library.addingToLibrary}
        canRefreshArtist={canChangeMonitoring}
        handleRefreshArtist={library.handleRefreshArtist}
        refreshingArtist={library.refreshingArtist}
        buildingQueue={buildingQueue}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlayAll={handlePreviewPlayAll}
        onEditIds={handleOpenEditIds}
        onTasteFeedback={handleCurrentArtistTasteFeedback}
        tasteFeedbackUsed={currentArtistFeedback}
        tasteActionPending={tasteActionPending}
      />

      <ArtistDetailsPreviewTracks
        mbid={mbid}
        artistName={artist?.name || artistNameFromNav || ""}
        loadingPreview={loadingPreview}
        previewTracks={previewTracks}
        playingPreviewId={playingPreviewId}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlay={handlePreviewPlay}
        onAddTrackToPlaylist={handlePreviewTrackAdd}
        resolveMembershipTrack={buildPreviewTrackPayload}
        playlists={sharedPlaylists}
        playlistsLoading={playlistModalLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistError={playlistModalError}
        getDefaultPlaylistName={getDefaultTrackPlaylistName}
        onLoadPlaylists={loadSharedPlaylists}
      />

      <ArtistDetailsDownloadTargets
        releaseGroups={artist?.["release-groups"] || []}
        getAlbumStatus={library.getAlbumStatus}
        artist={artist}
        albumCovers={albumCovers}
        artistCoverImage={artistCoverImage}
        canAddAlbum={canAddAlbum}
        requestingAlbum={library.requestingAlbum}
        handleRequestAlbum={library.handleRequestAlbum}
        playbackSource={playbackSource}
        artistName={artistDisplayName}
        onAddTrackToPlaylist={handleReleaseTrackAdd}
        resolveMembershipTrack={buildReleaseTrackPayload}
        playlists={sharedPlaylists}
        playlistsLoading={playlistModalLoading}
        playlistSavingKey={playlistMenuSavingKey}
        playlistError={playlistModalError}
        getDefaultPlaylistName={getDefaultTrackPlaylistName}
        onLoadPlaylists={loadSharedPlaylists}
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
          artistCoverImage={artistCoverImage}
          albumDropdownOpen={library.albumDropdownOpen}
          setAlbumDropdownOpen={library.setAlbumDropdownOpen}
          canDeleteAlbum={canDeleteAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          canReSearchAlbum={canAddAlbum}
          handleReSearchAlbum={library.handleReSearchAlbum}
          handleReSearchMissingDownloads={library.handleReSearchMissingDownloads}
          onVisibleCoverIdsChange={setVisibleLibraryCoverIds}
          artistName={artistDisplayName}
        />
      )}

      {(loadingReleases ||
        (artist["release-groups"] && artist["release-groups"].length > 0)) && (
        <ArtistDetailsReleaseGroups
          artist={artist}
          loadingReleases={loadingReleases}
          albumCovers={albumCovers}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          onVisibleCoverIdsChange={setVisibleReleaseGroupCoverIds}
          onViewAll={() =>
            navigate(`/artist/${artist.id}/albums`, {
              state: { artistName: artist.name, inLibrary: existsInLibrary },
            })
          }
        />
      )}

      {(loadingAppearsOn ||
        (artist["appears-on-release-groups"] &&
          artist["appears-on-release-groups"].length > 0)) && (
          <ArtistDetailsAppearsOn
            artist={artist}
            loadingAppearsOn={loadingAppearsOn}
            albumCovers={albumCovers}
            artistCoverImage={artistCoverImage}
            getAlbumStatus={library.getAlbumStatus}
            canAddAlbum={canAddAlbum}
            handleRequestAlbum={library.handleRequestAlbum}
            requestingAlbum={library.requestingAlbum}
            artistName={artistDisplayName}
            onVisibleCoverIdsChange={setVisibleAppearsOnCoverIds}
            onViewAll={() =>
              navigate(`/artist/${artist.id}/appears-on`, {
                state: { artistName: artist.name, inLibrary: existsInLibrary },
              })
            }
          />
        )}

      <ArtistDetailsAbout
        artist={artist}
        libraryArtist={libraryArtist}
        appSettings={appSettings}
        existsInLibrary={existsInLibrary}
        coverImages={coverImages}
        onNavigate={(path) => navigate(path)}
      />

      {(loadingSimilar || similarArtists.length > 0) && (
        <ArtistDetailsSimilar
          loadingSimilar={loadingSimilar}
          similarArtists={similarArtists}
          similarArtistsScrollRef={similarArtistsScrollRef}
          onArtistClick={(id, name, inLibrary = undefined) =>
            navigate(`/artist/${id}`, {
              state: {
                artistName: name,
                ...(typeof inLibrary === "boolean" ? { inLibrary } : {}),
              },
            })
          }
          canAddArtist={canAddArtist}
          onAddToLibrary={handleAddSimilarArtistToLibrary}
          onArtistFeedback={handleArtistTasteFeedback}
          artistFeedbackLookup={artistFeedbackLookup}
        />
      )}

      <DeleteArtistModal
        show={library.showDeleteModal && !!libraryArtist}
        artistName={artist?.name}
        libraryArtistName={libraryArtist?.artistName}
        deleteFiles={library.deleteFiles}
        onDeleteFilesChange={library.setDeleteFiles}
        onCancel={library.handleDeleteCancel}
        onConfirm={library.handleDeleteConfirm}
        deleting={library.deletingArtist}
      />

      <DeleteAlbumModal
        show={!!library.showDeleteAlbumModal}
        title={library.showDeleteAlbumModal?.title}
        deleteFiles={library.deleteAlbumFiles}
        onDeleteFilesChange={library.setDeleteAlbumFiles}
        onCancel={library.handleDeleteAlbumCancel}
        onConfirm={library.handleDeleteAlbumConfirm}
        removing={library.removingAlbum}
      />

      <AddArtistCustomizeModal
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
}) {
  if (!show) return null;
  return (
    <div
      className="artist-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="artist-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="artist-modal__header">
          <h3 className="artist-modal__title">
            Edit Artist IDs
          </h3>
          <button
            type="button"
            className="btn btn-surface btn-icon-square"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="artist-icon-md" />
          </button>
        </div>
        <p className="artist-modal__subcopy">
          {artistName ? `${artistName}: ` : ""}
          Update the MusicBrainz or Deezer ID to fix metadata and cover art.
        </p>
        <div className="artist-modal__fields">
          <div>
            <label className="artist-field-label">
              MusicBrainz ID
            </label>
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
            <label className="artist-field-label">
              Deezer Artist ID
            </label>
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
          <p className="artist-subtext">
            Leave both fields blank to clear overrides.
          </p>
          {error && (
            <div className="artist-error-text">
              {error}
            </div>
          )}
        </div>
        <div className="artist-modal__actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={loading || saving}
          >
            {saving ? "Saving..." : "Save IDs"}
          </button>
        </div>
      </div>
    </div>
  );
}
