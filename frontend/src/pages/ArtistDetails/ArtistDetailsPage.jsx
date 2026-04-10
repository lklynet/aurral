import { useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Loader, Music, ArrowLeft, X } from "lucide-react";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { useReleaseTypeFilter } from "./hooks/useReleaseTypeFilter";
import { usePreviewPlayer } from "./hooks/usePreviewPlayer";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { ArtistDetailsHero } from "./components/ArtistDetailsHero";
import { ArtistDetailsLibraryAlbums } from "./components/ArtistDetailsLibraryAlbums";
import { ArtistDetailsReleaseGroups } from "./components/ArtistDetailsReleaseGroups";
import { ArtistDetailsSimilar } from "./components/ArtistDetailsSimilar";
import { DeleteArtistModal } from "./components/DeleteArtistModal";
import { DeleteAlbumModal } from "./components/DeleteAlbumModal";
import {
  getArtistCover,
  getArtistDetails,
  getArtistOverrides,
  getArtistPreview,
  getSimilarArtistsForArtist,
  updateArtistOverrides,
} from "../../utils/api";

const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const { state: locationState } = useLocation();
  const navigate = useNavigate();
  const artistNameFromNav = locationState?.artistName;
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const similarArtistsScrollRef = useRef(null);
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsLoading, setIdsLoading] = useState(false);
  const [idsSaving, setIdsSaving] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });

  const stream = useArtistDetailsStream(mbid, artistNameFromNav);
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const canDeleteArtist = hasPermission("deleteArtist");
  const canDeleteAlbum = hasPermission("deleteAlbum");
  const canBulkAddAlbums = canAddAlbum && canChangeMonitoring;
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
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    setAlbumCovers,
    setArtist,
  } = stream;

  const filter = useReleaseTypeFilter();
  const {
    selectedReleaseTypes,
    setSelectedReleaseTypes,
    primaryReleaseTypes,
    secondaryReleaseTypes,
  } = filter;

  const preview = usePreviewPlayer(mbid, artistNameFromNav, artist);
  const {
    previewTracks,
    loadingPreview,
    setLoadingPreview,
    playingPreviewId,
    previewProgress,
    previewSnappingBack,
    previewVolume,
    setPreviewVolume,
    previewAudioRef,
    handlePreviewPlay,
    setPreviewTracks,
  } = preview;

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
        getArtistDetails(mbid, name).catch(() => null),
        getArtistCover(mbid, name, true).catch(() => ({ images: [] })),
        getArtistPreview(mbid, name).catch(() => ({ tracks: [] })),
        getSimilarArtistsForArtist(mbid).catch(() => ({ artists: [] })),
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

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <Loader
          className="w-12 h-12 animate-spin"
          style={{ color: "#c1c1c3" }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="text-center py-12">
          <Music
            className="w-16 h-16 mx-auto mb-4"
            style={{ color: "#c1c1c3" }}
          />
          <h3 className="text-xl font-semibold mb-2" style={{ color: "#fff" }}>
            Error Loading Artist
          </h3>
          <p className="mb-6" style={{ color: "#c1c1c3" }}>
            {error}
          </p>
          <button
            onClick={() => navigate("/search")}
            className="btn btn-primary"
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

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => navigate(-1)}
        className="btn btn-secondary mb-6 inline-flex items-center"
      >
        <ArrowLeft className="w-5 h-5 mr-2" />
        Back
      </button>

      <ArtistDetailsHero
        artist={artist}
        libraryArtist={libraryArtist}
        appSettings={appSettings}
        coverImages={coverImages}
        loadingCover={loadingCover}
        loadingLibrary={loadingLibrary}
        existsInLibrary={existsInLibrary}
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
        addingToLibrary={library.addingToLibrary}
        canRefreshArtist={canChangeMonitoring}
        handleRefreshArtist={library.handleRefreshArtist}
        refreshingArtist={library.refreshingArtist}
        onNavigate={(path) => navigate(path)}
        loadingPreview={loadingPreview}
        previewTracks={previewTracks}
        previewAudioRef={previewAudioRef}
        playingPreviewId={playingPreviewId}
        previewProgress={previewProgress}
        previewSnappingBack={previewSnappingBack}
        previewVolume={previewVolume}
        setPreviewVolume={setPreviewVolume}
        handlePreviewPlay={handlePreviewPlay}
        onEditIds={handleOpenEditIds}
      />

      {existsInLibrary && libraryAlbums && libraryAlbums.length > 0 && (
        <ArtistDetailsLibraryAlbums
          artist={artist}
          libraryAlbums={libraryAlbums}
          downloadStatuses={library.downloadStatuses}
          requestingAlbum={library.requestingAlbum}
          reSearchingAlbum={library.reSearchingAlbum}
          albumCovers={albumCovers}
          expandedLibraryAlbum={library.expandedLibraryAlbum}
          albumTracks={library.albumTracks}
          loadingTracks={library.loadingTracks}
          albumDropdownOpen={library.albumDropdownOpen}
          setAlbumDropdownOpen={library.setAlbumDropdownOpen}
          handleLibraryAlbumClick={library.handleLibraryAlbumClick}
          canDeleteAlbum={canDeleteAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          canReSearchAlbum={canAddAlbum}
          handleReSearchAlbum={library.handleReSearchAlbum}
        />
      )}

      {artist["release-groups"] && artist["release-groups"].length > 0 && (
        <ArtistDetailsReleaseGroups
          artist={artist}
          selectedReleaseTypes={selectedReleaseTypes}
          setSelectedReleaseTypes={setSelectedReleaseTypes}
          primaryReleaseTypes={primaryReleaseTypes}
          secondaryReleaseTypes={secondaryReleaseTypes}
          showFilterDropdown={showFilterDropdown}
          setShowFilterDropdown={setShowFilterDropdown}
          existsInLibrary={existsInLibrary}
          canBulkAddAlbums={canBulkAddAlbums}
          handleMonitorAll={library.handleMonitorAll}
          processingBulk={library.processingBulk}
          albumCovers={albumCovers}
          expandedReleaseGroup={library.expandedReleaseGroup}
          albumTracks={library.albumTracks}
          loadingTracks={library.loadingTracks}
          getAlbumStatus={library.getAlbumStatus}
          albumDropdownOpen={library.albumDropdownOpen}
          setAlbumDropdownOpen={library.setAlbumDropdownOpen}
          handleReleaseGroupAlbumClick={library.handleReleaseGroupAlbumClick}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          canDeleteAlbum={canDeleteAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          requestingAlbum={library.requestingAlbum}
          reSearchingAlbum={library.reSearchingAlbum}
          canReSearchAlbum={canAddAlbum}
          handleReSearchAlbum={library.handleReSearchAlbum}
          previewVolume={previewVolume}
          setPreviewVolume={setPreviewVolume}
          isReleaseGroupDownloadedInLibrary={
            library.isReleaseGroupDownloadedInLibrary
          }
        />
      )}

      {(loadingSimilar || similarArtists.length > 0) && (
        <ArtistDetailsSimilar
          loadingSimilar={loadingSimilar}
          similarArtists={similarArtists}
          similarArtistsScrollRef={similarArtistsScrollRef}
          onArtistClick={(id, name) =>
            navigate(`/artist/${id}`, { state: { artistName: name } })
          }
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
      onClick={onClose}
    >
      <div
        className="card max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold" style={{ color: "#fff" }}>
            Edit Artist IDs
          </h3>
          <button
            type="button"
            className="p-2 rounded transition-colors hover:bg-[#2a2a2e]"
            style={{ color: "#c1c1c3" }}
            onClick={onClose}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm mb-5" style={{ color: "#c1c1c3" }}>
          {artistName ? `${artistName}: ` : ""}
          Update the MusicBrainz or Deezer ID to fix metadata and cover art.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="block text-sm font-medium mb-2"
              style={{ color: "#fff" }}
            >
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
              className="w-full px-3 py-2 rounded border border-white/10 focus:outline-none"
              style={{ backgroundColor: "#1a1a1e", color: "#fff" }}
            />
          </div>
          <div>
            <label
              className="block text-sm font-medium mb-2"
              style={{ color: "#fff" }}
            >
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
              className="w-full px-3 py-2 rounded border border-white/10 focus:outline-none"
              style={{ backgroundColor: "#1a1a1e", color: "#fff" }}
            />
          </div>
          <p className="text-xs" style={{ color: "#c1c1c3" }}>
            Leave both fields blank to clear overrides.
          </p>
          {error && (
            <div className="text-sm" style={{ color: "#ff6b6b" }}>
              {error}
            </div>
          )}
        </div>
        <div className="flex gap-3 justify-end mt-6">
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
