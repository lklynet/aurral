import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Loader, Music, X } from "lucide-react";
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
import { AddArtistCustomizeModal } from "./components/AddArtistCustomizeModal";
import { PlaylistTrackModal } from "../../components/PlaylistModals";
import {
  addSharedPlaylistTracks,
  getArtistCover,
  getArtistDetails,
  getArtistOverrides,
  getArtistPreview,
  getFlowStatus,
  getSimilarArtistsForArtist,
  createSharedPlaylist,
  updateArtistOverrides,
  getBlocklist,
  updateBlocklist,
} from "../../utils/api";

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

const formatPlaylistSaveSuccess = (
  actionLabel,
  playlistName,
  { tracksReused = 0, tracksQueued = 0 } = {},
) => {
  const base = `${actionLabel} ${playlistName || "playlist"}`;
  if (tracksReused > 0 && tracksQueued > 0) {
    return `${base} (${tracksReused} reused from Lidarr, ${tracksQueued} queued for download)`;
  }
  if (tracksReused > 0) {
    return `${base} (${tracksReused} reused from Lidarr library)`;
  }
  if (tracksQueued > 0) {
    return `${base} (${tracksQueued} queued for download)`;
  }
  return base;
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
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsLoading, setIdsLoading] = useState(false);
  const [idsSaving, setIdsSaving] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistTrackModal, setPlaylistTrackModal] = useState(null);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalSubmitting, setPlaylistModalSubmitting] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [blockingArtist, setBlockingArtist] = useState(false);
  const [artistBlocked, setArtistBlocked] = useState(false);
  const [visibleReleaseGroupCoverIds, setVisibleReleaseGroupCoverIds] = useState(
    [],
  );
  const [visibleLibraryCoverIds, setVisibleLibraryCoverIds] = useState([]);

  const filter = useReleaseTypeFilter();
  const {
    selectedReleaseTypes,
    setSelectedReleaseTypes,
    primaryReleaseTypes,
    secondaryReleaseTypes,
  } = filter;

  const stream = useArtistDetailsStream(
    mbid,
    artistNameFromNav,
    selectedReleaseTypes,
    {
      visibleCoverIds: [
        ...visibleReleaseGroupCoverIds,
        ...visibleLibraryCoverIds,
      ],
      initialLibraryHint,
    },
  );
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
    loadingReleases,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    setAlbumCovers,
    setArtist,
  } = stream;

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

  const openPlaylistTrackModal = async (trackPayload) => {
    if (!trackPayload?.artistName || !trackPayload?.trackName) {
      showError("Track details are incomplete");
      return;
    }
    setPlaylistModalError("");
    const playlists = await loadSharedPlaylists();
    if (!playlists) return;
    setPlaylistTrackModal({
      tracks: [trackPayload],
      defaultNewPlaylistName: reserveUniquePlaylistName(
        playlists,
        `${trackPayload.artistName} Picks`,
      ),
    });
  };

  const handleReleaseTrackAdd = (track, releaseGroup) => {
    const year = String(
      releaseGroup?.["first-release-date"] || "",
    ).slice(0, 4);
    void openPlaylistTrackModal({
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
    });
  };

  const handleLibraryTrackAdd = (track, libraryAlbum, releaseGroupId) => {
    const year = String(libraryAlbum?.releaseDate || "").slice(0, 4);
    void openPlaylistTrackModal({
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track?.trackName || track?.title || "",
      albumName: libraryAlbum?.albumName || "",
      artistMbid: mbid || "",
      albumMbid: releaseGroupId || libraryAlbum?.mbid || "",
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: year || null,
      durationMs:
        track?.length != null && Number.isFinite(Number(track.length))
          ? Number(track.length)
          : null,
      reason: null,
      artistAliases: [],
    });
  };

  const handleSubmitPlaylistTrackModal = async (payload) => {
    setPlaylistModalSubmitting(true);
    setPlaylistModalError("");
    try {
      if (payload?.mode === "new") {
        const response = await createSharedPlaylist({
          name: payload.name,
          tracks: payload.tracks,
        });
        showSuccess(
          formatPlaylistSaveSuccess(
            "Track saved to",
            response?.playlist?.name || payload.name,
            response,
          ),
        );
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (playlist) => playlist.id === payload?.playlistId,
        );
        const response = await addSharedPlaylistTracks(payload.playlistId, {
          tracks: payload.tracks,
        });
        showSuccess(
          formatPlaylistSaveSuccess(
            "Track added to",
            targetPlaylist?.name || "playlist",
            response,
          ),
        );
      }
      setPlaylistTrackModal(null);
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
      setPlaylistModalSubmitting(false);
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
            className="btn btn-primary hidden sm:inline-flex"
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
        handleOpenAddCustomizeModal={library.handleOpenAddCustomizeModal}
        addingToLibrary={library.addingToLibrary}
        canRefreshArtist={canChangeMonitoring}
        handleRefreshArtist={library.handleRefreshArtist}
        refreshingArtist={library.refreshingArtist}
        onCoverError={handleCoverError}
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
          reSearchingMissingAlbums={library.reSearchingMissingAlbums}
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
          handleReSearchMissingDownloads={library.handleReSearchMissingDownloads}
          onAddTrackToPlaylist={handleLibraryTrackAdd}
          onVisibleCoverIdsChange={setVisibleLibraryCoverIds}
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
          loadingReleases={loadingReleases}
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
          onAddTrackToPlaylist={handleReleaseTrackAdd}
          onVisibleCoverIdsChange={setVisibleReleaseGroupCoverIds}
        />
      )}

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

      <PlaylistTrackModal
        open={!!playlistTrackModal}
        title="Add Track To Playlist"
        description={
          playlistModalLoading
            ? "Loading your playlists..."
            : "Save this song into an existing playlist or start a new one."
        }
        playlists={sharedPlaylists}
        initialTracks={playlistTrackModal?.tracks || []}
        defaultNewPlaylistName={
          playlistTrackModal?.defaultNewPlaylistName || "Playlist"
        }
        saving={playlistModalSubmitting || playlistModalLoading}
        error={playlistModalError}
        onClose={() => {
          if (playlistModalSubmitting || playlistModalLoading) return;
          setPlaylistModalError("");
          setPlaylistTrackModal(null);
        }}
        onSubmit={handleSubmitPlaylistTrackModal}
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
