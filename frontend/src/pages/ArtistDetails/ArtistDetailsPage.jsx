import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Loader, Music, ArrowLeft, X } from "lucide-react";
import { useToast } from "../../contexts/ToastContext";
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
  getBlocklist,
  updateBlocklist,
} from "../../utils/api";

const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const { state: locationState } = useLocation();
  const navigate = useNavigate();
  const artistNameFromNav = locationState?.artistName;
  const { showSuccess, showError } = useToast();
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
  const [blockingArtist, setBlockingArtist] = useState(false);
  const [artistBlocked, setArtistBlocked] = useState(false);

  const stream = useArtistDetailsStream(mbid, artistNameFromNav);
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
    previewAudioRef,
    handlePreviewPlay,
    setPreviewTracks,
  } = preview;

  const normalizeArtists = useCallback((artists) => {
    const source = Array.isArray(artists) ? artists : [];
    const seen = new Set();
    const out = [];
    for (const entry of source) {
      if (!entry) continue;
      const entryMbid =
        typeof entry.mbid === "string" && MBID_REGEX.test(entry.mbid.trim())
          ? entry.mbid.trim()
          : null;
      const entryName = String(entry.name || "").trim();
      if (!entryMbid && !entryName) continue;
      const key = entryMbid
        ? `mbid:${entryMbid.toLowerCase()}`
        : `name:${entryName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mbid: entryMbid, name: entryName || null });
    }
    return out;
  }, []);

  const isBlockedByEntries = useCallback((entries) => {
    const artistMbid = String(artist?.id || mbid || "")
      .trim()
      .toLowerCase();
    const artistName = String(artist?.name || artistNameFromNav || "")
      .trim()
      .toLowerCase();
    return entries.some((entry) => {
      const mbidValue = String(entry?.mbid || "")
        .trim()
        .toLowerCase();
      const nameValue = String(entry?.name || "")
        .trim()
        .toLowerCase();
      if (artistMbid && mbidValue && artistMbid === mbidValue) return true;
      if (artistName && nameValue && artistName === nameValue) return true;
      return false;
    });
  }, [artist?.id, artist?.name, artistNameFromNav, mbid]);

  const handleToggleBlockArtist = async () => {
    if (!artist) return;
    setBlockingArtist(true);
    try {
      const current = await getBlocklist();
      const entries = normalizeArtists(current.artists);
      const artistMbid =
        String(artist?.id || mbid || "").trim() || null;
      const artistName = String(artist?.name || artistNameFromNav || "").trim() || null;
      const exists = entries.some((entry) => {
        const entryMbid = String(entry?.mbid || "").trim().toLowerCase();
        const entryName = String(entry?.name || "").trim().toLowerCase();
        if (artistMbid && entryMbid && artistMbid.toLowerCase() === entryMbid) return true;
        if (artistName && entryName && artistName.toLowerCase() === entryName) return true;
        return false;
      });
      const nextArtists = exists
        ? entries.filter((entry) => {
            const entryMbid = String(entry?.mbid || "").trim().toLowerCase();
            const entryName = String(entry?.name || "").trim().toLowerCase();
            if (artistMbid && entryMbid && artistMbid.toLowerCase() === entryMbid) return false;
            if (artistName && entryName && artistName.toLowerCase() === entryName) return false;
            return true;
          })
        : [...entries, { mbid: artistMbid, name: artistName }];
      const response = await updateBlocklist({
        artists: nextArtists,
        tags: current.tags || [],
      });
      const savedArtists = normalizeArtists(response?.blocklist?.artists || nextArtists);
      const blocked = isBlockedByEntries(savedArtists);
      setArtistBlocked(blocked);
      showSuccess(blocked ? "Artist added to blocklist" : "Artist removed from blocklist");
    } catch (err) {
      showError(err.response?.data?.message || "Failed to update blocklist");
    } finally {
      setBlockingArtist(false);
    }
  };

  useEffect(() => {
    if (!artist && !mbid) return;
    let cancelled = false;
    const run = async () => {
      try {
        const data = await getBlocklist();
        if (cancelled) return;
        const entries = normalizeArtists(data.artists);
        setArtistBlocked(isBlockedByEntries(entries));
      } catch {
        if (!cancelled) {
          setArtistBlocked(false);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [artist, artistNameFromNav, isBlockedByEntries, mbid, normalizeArtists]);

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
        getCurrentMonitorOption={library.getCurrentMonitorOption}
        handleUpdateMonitorOption={library.handleUpdateMonitorOption}
        handleDeleteClick={library.handleDeleteClick}
        handleAddToLibrary={library.handleAddToLibrary}
        addingToLibrary={library.addingToLibrary}
        handleRefreshArtist={library.handleRefreshArtist}
        refreshingArtist={library.refreshingArtist}
        onNavigate={(path) => navigate(path)}
        loadingPreview={loadingPreview}
        previewTracks={previewTracks}
        previewAudioRef={previewAudioRef}
        playingPreviewId={playingPreviewId}
        previewProgress={previewProgress}
        previewSnappingBack={previewSnappingBack}
        handlePreviewPlay={handlePreviewPlay}
        onEditIds={handleOpenEditIds}
        onToggleBlockArtist={handleToggleBlockArtist}
        blockingArtist={blockingArtist}
        artistBlocked={artistBlocked}
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
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
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
          handleRequestAlbum={library.handleRequestAlbum}
          handleDeleteAlbumClick={library.handleDeleteAlbumClick}
          requestingAlbum={library.requestingAlbum}
          reSearchingAlbum={library.reSearchingAlbum}
          handleReSearchAlbum={library.handleReSearchAlbum}
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
