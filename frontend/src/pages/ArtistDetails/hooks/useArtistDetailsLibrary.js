import { useState, useEffect, useRef } from "react";
import {
  getLibraryAlbums,
  updateLibraryAlbum,
  deleteArtistFromLibrary,
  deleteAlbumFromLibrary,
  updateLibraryArtist,
  getLibraryArtist,
  downloadAlbum,
  triggerAlbumSearch,
  refreshLibraryArtist,
  getDownloadStatus,
  addArtistToLibrary,
  lookupArtistInLibrary,
  getMyLidarrPreferences,
} from "../../../utils/api";
import {
  deduplicateAlbums,
  isVisibleLibraryAlbum,
  matchesReleaseTypeFilter,
} from "../utils";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";

const DELETE_FILES_PREFERENCE_KEY = "aurral:library-delete-files";

const readDeleteFilesPreference = () => {
  try {
    return localStorage.getItem(DELETE_FILES_PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
};

const writeDeleteFilesPreference = (value) => {
  try {
    localStorage.setItem(DELETE_FILES_PREFERENCE_KEY, value ? "1" : "0");
  } catch {}
};

export function useArtistDetailsLibrary({
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
}) {
  const [requestingAlbum, setRequestingAlbum] = useState(null);
  const [removingAlbum, setRemovingAlbum] = useState(null);
  const [albumDropdownOpen, setAlbumDropdownOpen] = useState(null);
  const [showDeleteAlbumModal, setShowDeleteAlbumModal] = useState(null);
  const [deleteAlbumFiles, setDeleteAlbumFilesState] = useState(() =>
    readDeleteFilesPreference(),
  );
  const [processingBulk, setProcessingBulk] = useState(false);
  const [showRemoveDropdown, setShowRemoveDropdown] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFiles, setDeleteFilesState] = useState(() =>
    readDeleteFilesPreference(),
  );
  const [deletingArtist, setDeletingArtist] = useState(false);
  const [addingToLibrary, setAddingToLibrary] = useState(false);
  const [showMonitorOptionMenu, setShowMonitorOptionMenu] = useState(false);
  const [updatingMonitor, setUpdatingMonitor] = useState(false);
  const [refreshingArtist, setRefreshingArtist] = useState(false);
  const [downloadStatuses, setDownloadStatuses] = useState({});
  const [reSearchingAlbum, setReSearchingAlbum] = useState(null);
  const [reSearchingMissingAlbums, setReSearchingMissingAlbums] =
    useState(false);
  const [reSearchOverrides, setReSearchOverrides] = useState({});
  const [showAddCustomizeModal, setShowAddCustomizeModal] = useState(false);
  const [loadingLidarrPreferences, setLoadingLidarrPreferences] =
    useState(false);
  const [lidarrPreferences, setLidarrPreferences] = useState(null);
  const [customizeRootFolderPath, setCustomizeRootFolderPath] = useState("");
  const [customizeQualityProfileId, setCustomizeQualityProfileId] =
    useState("");
  const [customizeTagId, setCustomizeTagId] = useState("");
  const reSearchOverridesRef = useRef({});
  const unmonitoredAtRef = useRef({});
  const libraryAlbumIdsRef = useRef([]);
  const viewedArtistIdRef = useRef(artist?.id || null);
  const currentLibraryArtistIdRef = useRef(libraryArtist?.id || null);
  const libraryRefreshTimeoutsRef = useRef(new Set());

  useEffect(() => {
    viewedArtistIdRef.current = artist?.id || null;
    for (const timeoutId of libraryRefreshTimeoutsRef.current) {
      clearTimeout(timeoutId);
    }
    libraryRefreshTimeoutsRef.current.clear();
  }, [artist?.id]);

  useEffect(() => {
    currentLibraryArtistIdRef.current = libraryArtist?.id || null;
  }, [libraryArtist?.id]);

  useEffect(() => {
    libraryAlbumIdsRef.current = libraryAlbums
      .map((album) => String(album.id))
      .filter(Boolean);
  }, [libraryAlbums]);

  const updateDeleteFilesPreference = (value) => {
    writeDeleteFilesPreference(value);
    setDeleteFilesState(value);
    setDeleteAlbumFilesState(value);
  };

  useWebSocketChannel("downloads", (msg) => {
    if (msg?.type !== "download_statuses") return;
    const albumIds = libraryAlbumIdsRef.current;
    if (!albumIds.length) return;
    const incoming = msg.statuses || {};
    const next = {};
    for (const id of albumIds) {
      if (incoming[id]) next[id] = incoming[id];
    }
    if (requestingAlbum) {
      const album = libraryAlbums.find(
        (a) =>
          a.mbid === requestingAlbum || a.foreignAlbumId === requestingAlbum,
      );
      if (album && incoming[String(album.id)]) {
        setRequestingAlbum(null);
      }
    }
    setDownloadStatuses((prev) => ({ ...prev, ...next }));
  });

  const handleRefreshArtist = async () => {
    if (!libraryArtist?.mbid && !libraryArtist?.foreignArtistId) return;
    setRefreshingArtist(true);
    try {
      const mbid = libraryArtist.mbid || libraryArtist.foreignArtistId;
      await refreshLibraryArtist(mbid);
      setTimeout(async () => {
        try {
          const refreshedArtist = await getLibraryArtist(mbid);
          setLibraryArtist(refreshedArtist);
          const albums = await getLibraryAlbums(refreshedArtist.id);
          setLibraryAlbums(deduplicateAlbums(albums));
          showSuccess("Artist data refreshed successfully.");
        } catch (err) {
          console.error("Failed to refresh artist data:", err);
          showError("Failed to refresh artist data");
        } finally {
          setRefreshingArtist(false);
        }
      }, 2000);
    } catch (err) {
      showError(`Failed to refresh artist: ${err.message}`);
      setRefreshingArtist(false);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteModal(true);
  };

  const handleDeleteCancel = () => {
    setShowDeleteModal(false);
  };

  const handleDeleteConfirm = async () => {
    if (!libraryArtist?.id) return;
    setDeletingArtist(true);
    try {
      await deleteArtistFromLibrary(libraryArtist.mbid, deleteFiles);
      setExistsInLibrary(false);
      setLibraryArtist(null);
      setLibraryAlbums([]);
      showSuccess(
        `Successfully removed ${artist?.name || "artist"} from library${
          deleteFiles ? " and deleted files" : ""
        }`,
      );
      setShowDeleteModal(false);
    } catch (err) {
      showError(
        `Failed to delete artist: ${err.response?.data?.message || err.message}`,
      );
    } finally {
      setDeletingArtist(false);
    }
  };

  const handleUpdateMonitorOption = async (newMonitorOption) => {
    if (!libraryArtist?.id) return;
    setUpdatingMonitor(true);
    try {
      const updatedArtist = {
        ...libraryArtist,
        monitored: true,
        monitorOption: newMonitorOption,
        addOptions: {
          ...(libraryArtist.addOptions || {}),
          monitor: newMonitorOption,
        },
      };
      delete updatedArtist.statistics;
      delete updatedArtist.images;
      delete updatedArtist.links;
      await updateLibraryArtist(libraryArtist.mbid, updatedArtist);
      const refreshedArtist = await getLibraryArtist(libraryArtist.mbid);
      setLibraryArtist(refreshedArtist);
      setShowRemoveDropdown(false);
      const monitorLabels = {
        none: "None (Artist Only)",
        existing: "Existing Albums",
        all: "All Albums",
        future: "Future Albums",
        missing: "Missing Albums",
        latest: "Latest Album",
        first: "First Album",
      };
      showSuccess(
        `Monitor option updated to: ${monitorLabels[newMonitorOption]}`,
      );
    } catch (err) {
      console.error("Update error:", err);
      showError(
        `Failed to update monitor option: ${
          err.response?.data?.message ||
          err.response?.data?.error ||
          err.message
        }`,
      );
    } finally {
      setUpdatingMonitor(false);
    }
  };

  const resolveLookupArtist = async (
    lookupArtist,
    { refresh = true, hydrateAlbums = true } = {},
  ) => {
    if (!lookupArtist) return null;
    const lookupMbid = lookupArtist.mbid || lookupArtist.foreignArtistId;
    let fullArtist;
    try {
      fullArtist = await getLibraryArtist(lookupMbid);
    } catch {
      fullArtist = {
        ...lookupArtist,
        foreignArtistId: lookupArtist.foreignArtistId || lookupArtist.mbid,
      };
    }
    if (!fullArtist?.id) return null;
    setLibraryArtist(fullArtist);
    setExistsInLibrary(true);
    if (refresh) {
      await refreshLibraryArtist(fullArtist.mbid || fullArtist.foreignArtistId);
    }
    if (hydrateAlbums) {
      const albums = await getLibraryAlbums(fullArtist.id);
      setLibraryAlbums(deduplicateAlbums(albums));
    }
    return fullArtist;
  };

  const hydrateLibraryArtist = async (lookupArtist) => {
    return await resolveLookupArtist(lookupArtist, {
      refresh: true,
      hydrateAlbums: true,
    });
  };

  const resolveArtistFromAddResponse = async (
    result,
    { refresh = true, hydrateAlbums = true } = {},
  ) => {
    if (!result?.artist) return null;
    return await resolveLookupArtist(result.artist, {
      refresh,
      hydrateAlbums,
    });
  };

  const waitForLibraryArtist = async (
    mbid,
    {
      attempts = 20,
      delayMs = 1500,
      refresh = true,
      hydrateAlbums = true,
    } = {},
  ) => {
    for (let i = 0; i < attempts; i++) {
      try {
        const lookup = await lookupArtistInLibrary(mbid);
        if (lookup.exists && lookup.artist) {
          const resolved = await resolveLookupArtist(lookup.artist, {
            refresh,
            hydrateAlbums,
          }).catch(() => null);
          if (resolved?.id) return resolved;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  };

  const waitForLibraryAlbum = async (artistId, releaseGroupId) => {
    const attempts = 12;
    for (let i = 0; i < attempts; i++) {
      try {
        const albums = await getLibraryAlbums(artistId);
        const uniqueAlbums = deduplicateAlbums(albums);
        setLibraryAlbums(uniqueAlbums);
        const found = uniqueAlbums.find(
          (a) =>
            (a.mbid === releaseGroupId ||
              a.foreignAlbumId === releaseGroupId) &&
            a.artistId === artistId,
        );
        if (found) return found;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return null;
  };

  const getCurrentMonitorOption = () => {
    if (!libraryArtist) return "none";
    if (libraryArtist.monitored === false) return "none";
    const monitorOption =
      libraryArtist.monitorOption ||
      libraryArtist.addOptions?.monitor ||
      libraryArtist.monitorNewItems;
    if (
      monitorOption &&
      [
        "none",
        "existing",
        "all",
        "future",
        "missing",
        "latest",
        "first",
      ].includes(monitorOption)
    ) {
      return monitorOption;
    }
    return libraryArtist.monitored ? "all" : "none";
  };

  const applyCustomizeDefaults = (preferences) => {
    const nextRootFolderPath =
      preferences?.savedDefaults?.rootFolderPath ||
      preferences?.fallbacks?.rootFolderPath ||
      "";
    const nextQualityProfileId =
      preferences?.savedDefaults?.qualityProfileId != null
        ? String(preferences.savedDefaults.qualityProfileId)
        : preferences?.fallbacks?.qualityProfileId != null
          ? String(preferences.fallbacks.qualityProfileId)
          : "";
    const nextTagId =
      preferences?.savedDefaults?.tagId != null
        ? String(preferences.savedDefaults.tagId)
        : preferences?.fallbacks?.tagId != null
          ? String(preferences.fallbacks.tagId)
          : "";
    setCustomizeRootFolderPath(nextRootFolderPath);
    setCustomizeQualityProfileId(nextQualityProfileId);
    setCustomizeTagId(nextTagId);
  };

  const loadLidarrPreferenceState = async ({ force = false } = {}) => {
    if (!force && lidarrPreferences) {
      return lidarrPreferences;
    }
    setLoadingLidarrPreferences(true);
    try {
      const preferences = await getMyLidarrPreferences();
      setLidarrPreferences(preferences);
      return preferences;
    } finally {
      setLoadingLidarrPreferences(false);
    }
  };

  const handleOpenAddCustomizeModal = async () => {
    setShowAddCustomizeModal(true);
    try {
      const preferences = await loadLidarrPreferenceState();
      applyCustomizeDefaults(preferences);
    } catch (err) {
      setShowAddCustomizeModal(false);
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to load Lidarr preferences",
      );
    }
  };

  const addArtistWithOptions = async (overrides = {}) => {
    if (!artist) {
      showError("Artist information not available");
      return;
    }
    setAddingToLibrary(true);
    try {
      const result = await addArtistToLibrary({
        foreignArtistId: artist.id,
        artistName: artist.name,
        quality: appSettings?.quality || "standard",
        ...(Object.hasOwn(overrides, "rootFolderPath")
          ? { rootFolderPath: overrides.rootFolderPath }
          : {}),
        ...(Object.hasOwn(overrides, "qualityProfileId")
          ? { qualityProfileId: overrides.qualityProfileId }
          : {}),
        ...(Object.hasOwn(overrides, "tagId") ? { tagId: overrides.tagId } : {}),
      });
      let fullArtist = await resolveArtistFromAddResponse(result, {
        refresh: true,
        hydrateAlbums: true,
      });
      if (result?.queued) {
        showSuccess(`Adding ${artist.name}...`);
        fullArtist = await waitForLibraryArtist(artist.id);
      } else if (!fullArtist) {
        const lookup = await lookupArtistInLibrary(artist.id);
        if (lookup.exists && lookup.artist) {
          fullArtist = await hydrateLibraryArtist(lookup.artist);
        }
      }
      if (!fullArtist) {
        throw new Error("Artist is taking longer than expected to add");
      }
      showSuccess(`${artist.name} added to library successfully!`);
      return true;
    } catch (err) {
      showError(
        `Failed to add artist to library: ${
          err.response?.data?.message ||
          err.response?.data?.error ||
          err.message
        }`,
      );
      return false;
    } finally {
      setAddingToLibrary(false);
    }
  };

  const handleAddToLibrary = async () => addArtistWithOptions();

  const handleCustomizeAddToLibrary = async () => {
    const success = await addArtistWithOptions({
      rootFolderPath: customizeRootFolderPath || null,
      qualityProfileId: customizeQualityProfileId
        ? Number(customizeQualityProfileId)
        : null,
      tagId: customizeTagId ? Number(customizeTagId) : null,
    });
    if (success) {
      setShowAddCustomizeModal(false);
    }
    return success;
  };

  const handleRequestAlbum = async (albumId, title) => {
    setRequestingAlbum(albumId);
    let addedOptimistic = false;
    let currentLibraryArtist = libraryArtist;
    try {
      const resolveLibraryArtist = async () => {
        if (!artist) return libraryArtist;
        const lookup = await lookupArtistInLibrary(artist.id);
        if (lookup.exists && lookup.artist) {
          const artistMbid =
            lookup.artist.mbid || lookup.artist.foreignArtistId;
          try {
            const fullArtist = await getLibraryArtist(artistMbid);
            setLibraryArtist(fullArtist);
            setExistsInLibrary(true);
            return fullArtist;
          } catch {
            const fallbackArtist = {
              ...lookup.artist,
              foreignArtistId:
                lookup.artist.foreignArtistId || lookup.artist.mbid,
            };
            if (fallbackArtist.id) {
              setLibraryArtist(fallbackArtist);
              setExistsInLibrary(true);
              return fallbackArtist;
            }
          }
        }
        return libraryArtist;
      };

      if (!existsInLibrary || !libraryArtist?.id) {
        if (!artist) {
          showError("Artist information not available");
          return;
        }
        const result = await addArtistToLibrary({
          foreignArtistId: artist.id,
          artistName: artist.name,
          quality: appSettings?.quality || "standard",
        });
        let fullArtist = await resolveArtistFromAddResponse(result, {
          refresh: false,
          hydrateAlbums: false,
        });
        if (result?.queued) {
          showSuccess(`Adding ${artist.name}...`);
          fullArtist = await waitForLibraryArtist(artist.id, {
            attempts: 40,
            delayMs: 1500,
            refresh: false,
            hydrateAlbums: false,
          });
        } else if (!fullArtist) {
          const lookup = await lookupArtistInLibrary(artist.id);
          if (lookup.exists && lookup.artist) {
            fullArtist = await resolveLookupArtist(lookup.artist, {
              refresh: false,
              hydrateAlbums: false,
            });
          }
        }
        if (!fullArtist) {
          fullArtist = await resolveLibraryArtist();
        }
        if (!fullArtist) {
          fullArtist = await waitForLibraryArtist(artist.id, {
            attempts: 20,
            delayMs: 1500,
            refresh: false,
            hydrateAlbums: false,
          });
        }
        if (!fullArtist) {
          throw new Error("Failed to get library artist");
        }
        currentLibraryArtist = fullArtist;
      }

      if (!currentLibraryArtist?.id) {
        currentLibraryArtist = await resolveLibraryArtist();
      }
      if (!currentLibraryArtist?.id && artist?.id) {
        currentLibraryArtist = await waitForLibraryArtist(artist.id);
      }
      if (!currentLibraryArtist?.id) {
        throw new Error("Failed to get library artist");
      }

      let libraryAlbum = libraryAlbums.find(
        (a) =>
          (a.mbid === albumId || a.foreignAlbumId === albumId) &&
          a.artistId === currentLibraryArtist.id,
      );

      if (!libraryAlbum) {
        const pendingId = `pending-${albumId}`;
        const optimisticAlbum = {
          id: pendingId,
          mbid: albumId,
          foreignAlbumId: albumId,
          albumName: title,
          artistId: currentLibraryArtist.id,
          releaseDate: null,
          albumType: null,
          statistics: null,
          monitored: true,
        };
        setLibraryAlbums((prev) => [...prev, optimisticAlbum]);
        setDownloadStatuses((prev) => ({
          ...prev,
          [pendingId]: { status: "processing" },
        }));
        addedOptimistic = true;

        const { addLibraryAlbum } = await import("../../../utils/api");
        let addedAlbum = null;
        try {
          addedAlbum = await addLibraryAlbum(
            currentLibraryArtist.id,
            albumId,
            title,
          );
          if (addedAlbum?.id) {
            setDownloadStatuses((prev) => ({
              ...prev,
              [addedAlbum.id]: { status: "processing" },
            }));
          }
          const refreshedAlbums = await getLibraryAlbums(
            currentLibraryArtist.id,
          );
          const uniqueAlbums = deduplicateAlbums(refreshedAlbums);
          setLibraryAlbums(uniqueAlbums);
          libraryAlbum =
            uniqueAlbums.find(
              (a) =>
                (a.mbid === albumId || a.foreignAlbumId === albumId) &&
                a.artistId === currentLibraryArtist.id,
            ) ?? addedAlbum;
          if (!libraryAlbum) {
            libraryAlbum = await waitForLibraryAlbum(
              currentLibraryArtist.id,
              albumId,
            );
          }
        } catch {
          await refreshLibraryArtist(
            currentLibraryArtist.mbid || currentLibraryArtist.foreignArtistId,
          );
          const albums = await getLibraryAlbums(currentLibraryArtist.id);
          const uniqueAlbums = deduplicateAlbums(albums);
          setLibraryAlbums(uniqueAlbums);
          libraryAlbum = uniqueAlbums.find(
            (a) =>
              (a.mbid === albumId || a.foreignAlbumId === albumId) &&
              a.artistId === currentLibraryArtist.id,
          );
          if (!libraryAlbum) {
            libraryAlbum = await waitForLibraryAlbum(
              currentLibraryArtist.id,
              albumId,
            );
          }
          if (!libraryAlbum) {
            throw new Error(
              "Album not found for this artist. Please try again.",
            );
          }
        }
      }

      if (String(libraryAlbum.id).startsWith("pending-")) {
        const resolvedAlbum = await waitForLibraryAlbum(
          currentLibraryArtist.id,
          albumId,
        );
        if (resolvedAlbum) {
          libraryAlbum = resolvedAlbum;
        }
      }

      await updateLibraryAlbum(libraryAlbum.id, {
        ...libraryAlbum,
        monitored: true,
      });
      setLibraryAlbums((prev) =>
        prev.map((a) =>
          a.id === libraryAlbum.id ? { ...a, monitored: true } : a,
        ),
      );
      await downloadAlbum(currentLibraryArtist.id, libraryAlbum.id, {
        artistMbid:
          currentLibraryArtist.mbid || currentLibraryArtist.foreignArtistId,
        artistName: currentLibraryArtist.artistName,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshedAlbums = await getLibraryAlbums(currentLibraryArtist.id);
      setLibraryAlbums(deduplicateAlbums(refreshedAlbums));
      const artistMbid =
        currentLibraryArtist.mbid || currentLibraryArtist.foreignArtistId;
      if (artistMbid) {
        const refreshedArtist = await getLibraryArtist(artistMbid);
        if (refreshedArtist) {
          setLibraryArtist(refreshedArtist);
        }
      }
      showSuccess(`Downloading album: ${title}`);
    } catch (err) {
      setRequestingAlbum(null);
      if (addedOptimistic) {
        if (currentLibraryArtist?.id) {
          try {
            const refreshedAlbums = await getLibraryAlbums(
              currentLibraryArtist.id,
            );
            setLibraryAlbums(deduplicateAlbums(refreshedAlbums));
          } catch {
            setLibraryAlbums((prev) =>
              prev.filter((a) => a.id !== `pending-${albumId}`),
            );
          }
        } else {
          setLibraryAlbums((prev) =>
            prev.filter((a) => a.id !== `pending-${albumId}`),
          );
        }
        setDownloadStatuses((prev) => {
          const next = { ...prev };
          delete next[`pending-${albumId}`];
          return next;
        });
      }
      showError(`Failed to add album: ${err.message}`);
    }
  };

  const handleReSearchAlbum = async (libraryAlbumId, title) => {
    if (!libraryAlbumId) return;
    setReSearchingAlbum(libraryAlbumId);
    try {
      const overrideKey = String(libraryAlbumId);
      const overrideNext = {
        ...reSearchOverridesRef.current,
        [overrideKey]: Date.now(),
      };
      reSearchOverridesRef.current = overrideNext;
      setReSearchOverrides(overrideNext);
      const album = libraryAlbums.find((a) => a.id === libraryAlbumId);
      if (!album) throw new Error("Album not found in library");
      if (!album.monitored) {
        await updateLibraryAlbum(libraryAlbumId, { ...album, monitored: true });
        setLibraryAlbums((prev) =>
          prev.map((a) =>
            a.id === libraryAlbumId ? { ...a, monitored: true } : a,
          ),
        );
      }
      setDownloadStatuses((prev) => ({
        ...prev,
        [overrideKey]: { status: "searching" },
      }));
      await triggerAlbumSearch(libraryAlbumId);
      showSuccess(`Search triggered for ${title}`);
    } catch (err) {
      showError(
        `Failed to re-search album: ${
          err.response?.data?.message || err.message
        }`,
      );
    } finally {
      setReSearchingAlbum(null);
    }
  };

  const handleReSearchMissingDownloads = async () => {
    if (!libraryAlbums.length) return;
    setReSearchingMissingAlbums(true);
    try {
      const eligibleAlbums = libraryAlbums.filter((album) => {
        const albumId = String(album.id ?? "");
        if (!albumId || albumId.startsWith("pending-")) return false;
        const percentOfTracks = album.statistics?.percentOfTracks ?? 0;
        const sizeOnDisk = album.statistics?.sizeOnDisk ?? 0;
        const isComplete = percentOfTracks >= 100 || sizeOnDisk > 0;
        if (isComplete) return false;
        const downloadStatus = downloadStatuses[album.id];
        const isActiveSearch =
          downloadStatus &&
          ["adding", "searching", "downloading", "moving", "processing"].includes(
            downloadStatus.status,
          );
        if (isActiveSearch) return false;
        return downloadStatus?.status === "failed" || album.monitored;
      });

      if (eligibleAlbums.length === 0) {
        showSuccess("No missing downloads to re-search.");
        return;
      }

      const overrideAt = Date.now();
      const overrideNext = { ...reSearchOverridesRef.current };
      const nextStatuses = { ...downloadStatuses };

      for (const album of eligibleAlbums) {
        overrideNext[String(album.id)] = overrideAt;
        nextStatuses[album.id] = { status: "searching" };
      }

      reSearchOverridesRef.current = overrideNext;
      setReSearchOverrides(overrideNext);
      setDownloadStatuses(nextStatuses);

      for (const album of eligibleAlbums) {
        if (!album.monitored) {
          await updateLibraryAlbum(album.id, { ...album, monitored: true });
        }
      }

      setLibraryAlbums((prev) =>
        prev.map((album) =>
          eligibleAlbums.some((candidate) => candidate.id === album.id)
            ? { ...album, monitored: true }
            : album,
        ),
      );

      await Promise.all(
        eligibleAlbums.map((album) => triggerAlbumSearch(album.id)),
      );

      showSuccess(
        `Triggered search for ${eligibleAlbums.length} missing download${
          eligibleAlbums.length === 1 ? "" : "s"
        }`,
      );
    } catch (err) {
      showError(
        `Failed to re-search missing downloads: ${
          err.response?.data?.message || err.message
        }`,
      );
    } finally {
      setReSearchingMissingAlbums(false);
    }
  };

  const handleDeleteAlbumClick = (albumId, title) => {
    setShowDeleteAlbumModal({ id: albumId, title });
    setAlbumDropdownOpen(null);
  };

  const handleDeleteAlbumCancel = () => {
    setShowDeleteAlbumModal(null);
  };

  const handleDeleteAlbumConfirm = async () => {
    if (!showDeleteAlbumModal) return;
    const { id: albumId, title } = showDeleteAlbumModal;
    try {
      const libraryAlbum = libraryAlbums.find(
        (a) => a.foreignAlbumId === albumId,
      );
      if (!libraryAlbum) throw new Error("Album not found in library");
      setRemovingAlbum(albumId);
      if (deleteAlbumFiles) {
        await deleteAlbumFromLibrary(libraryAlbum.id, true);
        setLibraryAlbums((prev) =>
          prev.filter((a) => a.id !== libraryAlbum.id),
        );
        showSuccess(`Successfully deleted ${title} and files`);
      } else {
        await updateLibraryAlbum(libraryAlbum.id, { monitored: false });
        unmonitoredAtRef.current[libraryAlbum.id] = Date.now();
        setLibraryAlbums((prev) =>
          prev.map((a) =>
            a.id === libraryAlbum.id ? { ...a, monitored: false } : a,
          ),
        );
        showSuccess(`Successfully unmonitored ${title}`);
      }
      setShowDeleteAlbumModal(null);
    } catch (err) {
      showError(
        `Failed to ${deleteAlbumFiles ? "delete" : "unmonitor"} album: ${
          err.response?.data?.message || err.message
        }`,
      );
    } finally {
      setRemovingAlbum(null);
    }
  };

  const isReleaseGroupDownloadedInLibrary = (releaseGroupId) => {
    if (!existsInLibrary || !libraryAlbums?.length) return false;
    const album = libraryAlbums.find(
      (a) => a.mbid === releaseGroupId || a.foreignAlbumId === releaseGroupId,
    );
    if (!album || String(album.id ?? "").startsWith("pending-")) return false;
    return isVisibleLibraryAlbum(album, { requestingAlbum });
  };

  const handleMonitorAll = async () => {
    if (!libraryAlbums.length || !artist?.["release-groups"]) return;
    const visibleReleaseGroups = artist["release-groups"].filter((rg) =>
      matchesReleaseTypeFilter(rg, selectedReleaseTypes),
    );
    const visibleMbids = new Set(visibleReleaseGroups.map((rg) => rg.id));
    const unmonitored = libraryAlbums.filter(
      (a) => !a.monitored && visibleMbids.has(a.mbid),
    );
    if (unmonitored.length === 0) {
      showSuccess("No new unmonitored albums in current view!");
      return;
    }
    setProcessingBulk(true);
    try {
      const ids = unmonitored.map((a) => a.id);
      for (const id of ids) {
        const album = libraryAlbums.find((a) => a.id === id);
        if (album) {
          await updateLibraryAlbum(id, { ...album, monitored: true });
          await downloadAlbum(libraryArtist.id, id);
        }
      }
      setLibraryAlbums((prev) =>
        prev.map((a) => (ids.includes(a.id) ? { ...a, monitored: true } : a)),
      );
      showSuccess(`Added ${ids.length} albums to monitor`);
    } catch (err) {
      console.error(err);
      showError("Failed to add albums");
    } finally {
      setProcessingBulk(false);
    }
  };

  const getAlbumStatus = (releaseGroupId) => {
    if (!existsInLibrary || !libraryArtist || libraryAlbums.length === 0) {
      return null;
    }
    const album = libraryAlbums.find(
      (a) => a.mbid === releaseGroupId || a.foreignAlbumId === releaseGroupId,
    );
    if (!album) return null;
    const isComplete =
      album.statistics?.percentOfTracks >= 100 ||
      album.statistics?.sizeOnDisk > 0;
    const statusKey = String(album.id);
    if (isComplete) {
      return {
        status: "available",
        label: "Complete",
        libraryId: album.id,
        albumInfo: album,
      };
    }
    const downloadStatus = downloadStatuses[statusKey];
    const overrideAt = reSearchOverrides[statusKey];
    const isRetrying =
      overrideAt != null && Date.now() - overrideAt < 5 * 60 * 1000;
    const effectiveStatus =
      isRetrying && downloadStatus?.status === "failed"
        ? { ...downloadStatus, status: "searching" }
        : downloadStatus;
    if (effectiveStatus) {
      const statusLabels = {
        adding: "Adding...",
        searching: "Searching...",
        downloading: "Downloading...",
        moving: "Moving files...",
        added: "Added",
        processing: "Searching...",
        failed: "Failed",
      };
      return {
        status: effectiveStatus.status,
        label: statusLabels[effectiveStatus.status] || effectiveStatus.status,
        libraryId: album.id,
        albumInfo: album,
        downloadStatus: effectiveStatus,
      };
    }
    if (album.monitored) {
      return {
        status: "monitored",
        label: "Monitored",
        libraryId: album.id,
        albumInfo: album,
      };
    }
    return {
      status: "unmonitored",
      label: "Not Monitored",
      libraryId: album.id,
      albumInfo: album,
    };
  };

  useEffect(() => {
    if (!libraryArtist) return;
    const viewedArtistId = artist?.id || null;
    const libraryArtistId = libraryArtist.id;
    const refreshTimeouts = libraryRefreshTimeoutsRef.current;
    const pollDownloadStatus = async () => {
      try {
        const albumIds = libraryAlbumIdsRef.current;
        if (albumIds.length > 0) {
          const statuses = await getDownloadStatus(albumIds);
          if (requestingAlbum) {
            const album = libraryAlbums.find(
              (a) =>
                a.mbid === requestingAlbum ||
                a.foreignAlbumId === requestingAlbum,
            );
            if (album && statuses[album.id]) {
              setRequestingAlbum(null);
            }
          }
          const now = Date.now();
          const currentOverrides = reSearchOverridesRef.current;
          const nextOverrides = { ...currentOverrides };
          for (const albumId of Object.keys(nextOverrides)) {
            const overrideAt = nextOverrides[albumId];
            if (overrideAt == null) continue;
            const status = statuses[albumId]?.status;
            const isExpired = now - overrideAt > 5 * 60 * 1000;
            const isCleared = status && status !== "failed";
            if (isExpired || isCleared) {
              delete nextOverrides[albumId];
            }
          }
          const overridesChanged =
            Object.keys(nextOverrides).length !==
              Object.keys(currentOverrides).length ||
            Object.keys(nextOverrides).some(
              (key) => nextOverrides[key] !== currentOverrides[key],
            );
          if (overridesChanged) {
            reSearchOverridesRef.current = nextOverrides;
            setReSearchOverrides(nextOverrides);
          }

          const nextStatuses = { ...statuses };
          for (const albumId of Object.keys(nextStatuses)) {
            const overrideAt = nextOverrides[albumId];
            if (
              overrideAt != null &&
              nextStatuses[albumId]?.status === "failed" &&
              now - overrideAt < 5 * 60 * 1000
            ) {
              nextStatuses[albumId] = {
                ...nextStatuses[albumId],
                status: "searching",
              };
            }
          }

          setDownloadStatuses((prevStatuses) => {
            const mergedStatuses = { ...prevStatuses, ...nextStatuses };
            const hasNewlyAdded = Object.keys(nextStatuses).some((albumId) => {
              const currentStatus = nextStatuses[albumId]?.status;
              const previousStatus = prevStatuses[albumId]?.status;
              return currentStatus === "added" && previousStatus !== "added";
            });
            const hasActiveDownloads = Object.values(nextStatuses).some(
              (s) =>
                s &&
                (s.status === "downloading" ||
                  s.status === "processing" ||
                  s.status === "adding"),
            );
            if (hasNewlyAdded || hasActiveDownloads) {
              const timeoutId = setTimeout(async () => {
                refreshTimeouts.delete(timeoutId);
                if (
                  viewedArtistIdRef.current !== viewedArtistId ||
                  currentLibraryArtistIdRef.current !== libraryArtistId
                ) {
                  return;
                }
                try {
                  const refreshedAlbums = await getLibraryAlbums(
                    libraryArtistId,
                  );
                  if (
                    viewedArtistIdRef.current !== viewedArtistId ||
                    currentLibraryArtistIdRef.current !== libraryArtistId
                  ) {
                    return;
                  }
                  const now = Date.now();
                  const cutoff = now - 120000;
                  const merged = refreshedAlbums.map((a) => {
                    const at = unmonitoredAtRef.current[a.id];
                    if (at != null && at >= cutoff && a.monitored)
                      return { ...a, monitored: false };
                    return a;
                  });
                  setLibraryAlbums(deduplicateAlbums(merged));
                } catch (err) {
                  console.error("Failed to refresh albums:", err);
                }
              }, hasNewlyAdded ? 2000 : 5000);
              refreshTimeouts.add(timeoutId);
            }
            return mergedStatuses;
          });
        }
      } catch (error) {
        console.error("Failed to fetch download status:", error);
      }
    };
    pollDownloadStatus();
    const interval = setInterval(pollDownloadStatus, 15000);
    return () => {
      clearInterval(interval);
      for (const timeoutId of refreshTimeouts) {
        clearTimeout(timeoutId);
      }
      refreshTimeouts.clear();
    };
  }, [artist?.id, libraryArtist, libraryAlbums, requestingAlbum, setLibraryAlbums]);

  useEffect(() => {
    if (!libraryArtist) return;
    const viewedArtistId = artist?.id || null;
    const libraryArtistId = libraryArtist.id;
    const refreshAlbums = async () => {
      try {
        const refreshedAlbums = await getLibraryAlbums(libraryArtistId);
        if (
          viewedArtistIdRef.current !== viewedArtistId ||
          currentLibraryArtistIdRef.current !== libraryArtistId
        ) {
          return;
        }
        const now = Date.now();
        const cutoff = now - 120000;
        const merged = refreshedAlbums.map((a) => {
          const at = unmonitoredAtRef.current[a.id];
          if (at != null && at >= cutoff && a.monitored)
            return { ...a, monitored: false };
          return a;
        });
        setLibraryAlbums(deduplicateAlbums(merged));
      } catch (err) {
        console.error("Failed to refresh albums:", err);
      }
    };
    const interval = setInterval(refreshAlbums, 30000);
    return () => clearInterval(interval);
  }, [artist?.id, libraryArtist, setLibraryAlbums]);

  return {
    requestingAlbum,
    removingAlbum,
    albumDropdownOpen,
    setAlbumDropdownOpen,
    showDeleteAlbumModal,
    deleteAlbumFiles,
    setDeleteAlbumFiles: updateDeleteFilesPreference,
    processingBulk,
    showRemoveDropdown,
    setShowRemoveDropdown,
    showDeleteModal,
    deleteFiles,
    setDeleteFiles: updateDeleteFilesPreference,
    deletingArtist,
    addingToLibrary,
    showAddCustomizeModal,
    setShowAddCustomizeModal,
    loadingLidarrPreferences,
    lidarrPreferences,
    customizeRootFolderPath,
    setCustomizeRootFolderPath,
    customizeQualityProfileId,
    setCustomizeQualityProfileId,
    customizeTagId,
    setCustomizeTagId,
    showMonitorOptionMenu,
    setShowMonitorOptionMenu,
    updatingMonitor,
    refreshingArtist,
    reSearchingAlbum,
    reSearchingMissingAlbums,
    downloadStatuses,
    handleRefreshArtist,
    handleDeleteClick,
    handleDeleteCancel,
    handleDeleteConfirm,
    handleUpdateMonitorOption,
    getCurrentMonitorOption,
    handleAddToLibrary,
    handleOpenAddCustomizeModal,
    handleCustomizeAddToLibrary,
    handleRequestAlbum,
    handleReSearchAlbum,
    handleReSearchMissingDownloads,
    handleDeleteAlbumClick,
    handleDeleteAlbumCancel,
    handleDeleteAlbumConfirm,
    handleMonitorAll,
    getAlbumStatus,
    isReleaseGroupDownloadedInLibrary,
  };
}
