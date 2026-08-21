import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getLibraryAlbums,
  updateLibraryAlbum,
  deleteArtistFromLibrary,
  deleteAlbumFromLibrary,
  updateLibraryArtist,
  getLibraryArtist,
  triggerAlbumSearch,
  refreshLibraryArtist,
  getDownloadStatus,
  addArtistToLibrary,
  lookupArtistInLibrary,
  requestAlbumFromSearch,
} from "../../../utils/api/endpoints/library.js";
import { getMyLidarrPreferences } from "../../../utils/api/endpoints/auth.js";
import { deduplicateAlbums } from "../utils";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";
import { queryClient, queryKeys } from "../../../queryClient.js";

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
}) {
  const [requestingAlbum, setRequestingAlbum] = useState(null);
  const [removingAlbum, setRemovingAlbum] = useState(null);
  const [albumDropdownOpen, setAlbumDropdownOpen] = useState(null);
  const [showDeleteAlbumModal, setShowDeleteAlbumModal] = useState(null);
  const [deleteAlbumFiles, setDeleteAlbumFilesState] = useState(() => readDeleteFilesPreference());
  const [showRemoveDropdown, setShowRemoveDropdown] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFiles, setDeleteFilesState] = useState(() => readDeleteFilesPreference());
  const [deletingArtist, setDeletingArtist] = useState(false);
  const [addingToLibrary, setAddingToLibrary] = useState(false);
  const [showMonitorOptionMenu, setShowMonitorOptionMenu] = useState(false);
  const [updatingMonitor, setUpdatingMonitor] = useState(false);
  const [refreshingArtist, setRefreshingArtist] = useState(false);
  const [reSearchingAlbum, setReSearchingAlbum] = useState(null);
  const [reSearchingMissingAlbums, setReSearchingMissingAlbums] = useState(false);
  const [reSearchOverrides, setReSearchOverrides] = useState({});
  const [showAddCustomizeModal, setShowAddCustomizeModal] = useState(false);
  const [customizeRootFolderPath, setCustomizeRootFolderPath] = useState("");
  const [customizeQualityProfileId, setCustomizeQualityProfileId] = useState("");
  const [customizeTagId, setCustomizeTagId] = useState("");
  const reSearchOverridesRef = useRef({});
  const previousDownloadStatusesRef = useRef({});
  const downloadStatusesRef = useRef({});
  const unmonitoredAtRef = useRef({});
  const libraryAlbumIdsRef = useRef([]);
  const libraryAlbumsRef = useRef(libraryAlbums);
  const viewedArtistIdRef = useRef(artist?.id || null);
  const currentLibraryArtistIdRef = useRef(libraryArtist?.id || null);
  const libraryRefreshTimeoutsRef = useRef(new Set());
  const { isConnected: downloadStatusWsConnected } = useWebSocketChannel("downloads", (msg) => {
    if (msg?.type !== "download_statuses") return;
    const albumIds = libraryAlbumIdsRef.current;
    if (!albumIds.length) return;
    const incoming = msg.statuses || {};
    const next = {};
    for (const id of albumIds) {
      if (incoming[id]) next[id] = incoming[id];
    }
    if (requestingAlbum) {
      const album = libraryAlbumsRef.current.find(
        (a) => a.mbid === requestingAlbum || a.foreignAlbumId === requestingAlbum,
      );
      if (album && incoming[String(album.id)]) {
        setRequestingAlbum(null);
      }
    }
    queryClient.setQueryData(queryKeys.downloadStatus(albumIds), (previous = {}) => ({
      ...previous,
      ...next,
    }));
  });
  const lidarrPreferencesQuery = useQuery({
    queryKey: queryKeys.lidarrPreferences("current"),
    queryFn: ({ signal }) => getMyLidarrPreferences({ signal }),
    enabled: false,
    staleTime: 30_000,
  });
  const downloadStatusIds = useMemo(
    () => libraryAlbums.map((album) => String(album.id)).filter(Boolean),
    [libraryAlbums],
  );
  const downloadStatusesQuery = useQuery({
    queryKey: queryKeys.downloadStatus(downloadStatusIds),
    queryFn: ({ signal }) =>
      getDownloadStatus(downloadStatusIds, { signal, bypassCache: true }),
    enabled: Boolean(libraryArtist && downloadStatusIds.length),
    staleTime: 4_000,
    refetchInterval: (currentQuery) => {
      if (
        downloadStatusWsConnected ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return false;
      }
      const statuses = currentQuery.state.data || {};
      const hasActiveDownloads = Object.values(statuses).some((status) =>
        status &&
        ["downloading", "processing", "adding"].includes(status.status),
      );
      return hasActiveDownloads ? 15_000 : false;
    },
  });
  const downloadStatuses = useMemo(() => {
    const statuses = downloadStatusesQuery.data || {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(statuses).map(([albumId, status]) => {
        const overrideAt = reSearchOverrides[albumId];
        if (
          overrideAt != null &&
          status?.status === "failed" &&
          now - overrideAt < 5 * 60 * 1000
        ) {
          return [albumId, { ...status, status: "searching" }];
        }
        return [albumId, status];
      }),
    );
  }, [downloadStatusesQuery.data, reSearchOverrides]);

  useEffect(() => {
    const refreshTimeouts = libraryRefreshTimeoutsRef.current;
    viewedArtistIdRef.current = artist?.id || null;
    for (const timeoutId of refreshTimeouts) {
      clearTimeout(timeoutId);
    }
    refreshTimeouts.clear();
    return () => {
      for (const timeoutId of refreshTimeouts) {
        clearTimeout(timeoutId);
      }
      refreshTimeouts.clear();
    };
  }, [artist?.id]);

  useEffect(() => {
    currentLibraryArtistIdRef.current = libraryArtist?.id || null;
  }, [libraryArtist?.id]);

  useEffect(() => {
    libraryAlbumsRef.current = libraryAlbums;
    libraryAlbumIdsRef.current = libraryAlbums.map((album) => String(album.id)).filter(Boolean);
  }, [libraryAlbums]);

  const updateDeleteFilesPreference = (value) => {
    writeDeleteFilesPreference(value);
    setDeleteFilesState(value);
    setDeleteAlbumFilesState(value);
  };

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
      showError(`Failed to delete artist: ${err.response?.data?.message || err.message}`);
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
      showSuccess(`Monitor option updated to: ${monitorLabels[newMonitorOption]}`);
    } catch (err) {
      console.error("Update error:", err);
      showError(
        `Failed to update monitor option: ${
          err.response?.data?.message || err.response?.data?.error || err.message
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

  const getCurrentMonitorOption = () => {
    if (!libraryArtist) return "none";
    if (libraryArtist.monitored === false) return "none";
    const monitorOption =
      libraryArtist.monitorOption ||
      libraryArtist.addOptions?.monitor ||
      libraryArtist.monitorNewItems;
    if (
      monitorOption &&
      ["none", "existing", "all", "future", "missing", "latest", "first"].includes(monitorOption)
    ) {
      return monitorOption;
    }
    return libraryArtist.monitored ? "all" : "none";
  };

  const applyCustomizeDefaults = (preferences) => {
    const nextRootFolderPath =
      preferences?.savedDefaults?.rootFolderPath || preferences?.fallbacks?.rootFolderPath || "";
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
    if (!force && lidarrPreferencesQuery.data) return lidarrPreferencesQuery.data;
    const { data } = await lidarrPreferencesQuery.refetch({ throwOnError: true });
    return data;
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
      if (!fullArtist) {
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
          err.response?.data?.message || err.response?.data?.error || err.message
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
      qualityProfileId: customizeQualityProfileId ? Number(customizeQualityProfileId) : null,
      tagId: customizeTagId ? Number(customizeTagId) : null,
    });
    if (success) {
      setShowAddCustomizeModal(false);
    }
    return success;
  };

  const handleRequestAlbum = async (albumId, title) => {
    setRequestingAlbum(albumId);
    try {
      if (!artist?.id || !artist?.name) {
        throw new Error("Artist information not available");
      }

      const result = await requestAlbumFromSearch({
        albumMbid: albumId,
        albumName: title,
        artistMbid: artist.id,
        artistName: artist.name,
        triggerSearch: true,
      });
      const addedArtist = result?.artist;
      const addedAlbum = result?.album;
      if (!addedArtist?.id || !addedAlbum?.id) {
        throw new Error("Lidarr did not return the completed album request");
      }

      setLibraryArtist({
        ...addedArtist,
        foreignArtistId: addedArtist.foreignArtistId || addedArtist.mbid || artist.id,
      });
      setExistsInLibrary(true);
      setLibraryAlbums((previous) =>
        deduplicateAlbums([
          ...previous.filter(
            (album) =>
              album.id !== `pending-${albumId}` &&
              album.mbid !== albumId &&
              album.foreignAlbumId !== albumId,
          ),
          {
            ...addedAlbum,
            mbid: addedAlbum.mbid || addedAlbum.foreignAlbumId || albumId,
            foreignAlbumId: addedAlbum.foreignAlbumId || addedAlbum.mbid || albumId,
            monitored: true,
          },
        ]),
      );
      const nextDownloadStatusIds = [
        ...new Set([...downloadStatusIds, String(addedAlbum.id)].filter(Boolean)),
      ];
      queryClient.setQueryData(
        queryKeys.downloadStatus(nextDownloadStatusIds),
        (previous = {}) => {
          const next = { ...previous };
          delete next[`pending-${albumId}`];
          next[addedAlbum.id] = { status: result.status || "searching" };
          return next;
        },
      );
      showSuccess(`Downloading album: ${title}`);
    } catch (err) {
      showError(
        `Failed to add album: ${
          err.response?.data?.message || err.response?.data?.error || err.message
        }`,
      );
    } finally {
      setRequestingAlbum(null);
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
          prev.map((a) => (a.id === libraryAlbumId ? { ...a, monitored: true } : a)),
        );
      }
      queryClient.setQueryData(
        queryKeys.downloadStatus(downloadStatusIds),
        (previous = {}) => ({
          ...previous,
          [overrideKey]: { status: "searching" },
        }),
      );
      await triggerAlbumSearch(libraryAlbumId);
      showSuccess(`Search triggered for ${title}`);
    } catch (err) {
      showError(`Failed to re-search album: ${err.response?.data?.message || err.message}`);
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
      queryClient.setQueryData(queryKeys.downloadStatus(downloadStatusIds), nextStatuses);

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

      await Promise.all(eligibleAlbums.map((album) => triggerAlbumSearch(album.id)));

      showSuccess(
        `Triggered search for ${eligibleAlbums.length} missing download${
          eligibleAlbums.length === 1 ? "" : "s"
        }`,
      );
    } catch (err) {
      showError(
        `Failed to re-search missing downloads: ${err.response?.data?.message || err.message}`,
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
      const libraryAlbum = libraryAlbums.find((a) => a.foreignAlbumId === albumId);
      if (!libraryAlbum) throw new Error("Album not found in library");
      setRemovingAlbum(albumId);
      if (deleteAlbumFiles) {
        await deleteAlbumFromLibrary(libraryAlbum.id, true);
        setLibraryAlbums((prev) => prev.filter((a) => a.id !== libraryAlbum.id));
        showSuccess(`Successfully deleted ${title} and files`);
      } else {
        await updateLibraryAlbum(libraryAlbum.id, { monitored: false });
        unmonitoredAtRef.current[libraryAlbum.id] = Date.now();
        setLibraryAlbums((prev) =>
          prev.map((a) => (a.id === libraryAlbum.id ? { ...a, monitored: false } : a)),
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

  const getAlbumStatus = (releaseGroupId) => {
    if (!existsInLibrary || !libraryArtist || libraryAlbums.length === 0) {
      return null;
    }
    const album = libraryAlbums.find(
      (a) => a.mbid === releaseGroupId || a.foreignAlbumId === releaseGroupId,
    );
    if (!album) return null;
    const isComplete = album.statistics?.percentOfTracks >= 100 || album.statistics?.sizeOnDisk > 0;
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
    const isRetrying = overrideAt != null && Date.now() - overrideAt < 5 * 60 * 1000;
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
    const statuses = downloadStatusesQuery.data || {};
    if (!libraryArtist) return;

    if (requestingAlbum) {
      const album = libraryAlbumsRef.current.find(
        (a) => a.mbid === requestingAlbum || a.foreignAlbumId === requestingAlbum,
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
      if (now - overrideAt > 5 * 60 * 1000 || (status && status !== "failed")) {
        delete nextOverrides[albumId];
      }
    }
    const overridesChanged =
      Object.keys(nextOverrides).length !== Object.keys(currentOverrides).length ||
      Object.keys(nextOverrides).some((key) => nextOverrides[key] !== currentOverrides[key]);
    if (overridesChanged) {
      reSearchOverridesRef.current = nextOverrides;
      setReSearchOverrides(nextOverrides);
    }
  }, [downloadStatusesQuery.data, libraryArtist, requestingAlbum]);

  useEffect(() => {
    const statuses = downloadStatusesQuery.data || {};
    const previousStatuses = previousDownloadStatusesRef.current;
    previousDownloadStatusesRef.current = statuses;
    if (!libraryArtist || !Object.keys(statuses).length) return;

    const hasNewlyAdded = Object.keys(statuses).some(
      (albumId) =>
        statuses[albumId]?.status === "added" &&
        previousStatuses[albumId]?.status !== "added",
    );
    const hasActiveDownloads = Object.values(statuses).some(
      (status) =>
        status &&
        ["downloading", "processing", "adding"].includes(status.status),
    );
    if (!hasNewlyAdded && !hasActiveDownloads) return;
    if (libraryRefreshTimeoutsRef.current.size) return;

    const viewedArtistId = artist?.id || null;
    const libraryArtistId = libraryArtist.id;
    const timeoutId = setTimeout(
      async () => {
        libraryRefreshTimeoutsRef.current.delete(timeoutId);
        if (
          viewedArtistIdRef.current !== viewedArtistId ||
          currentLibraryArtistIdRef.current !== libraryArtistId
        ) {
          return;
        }
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
          const merged = refreshedAlbums.map((album) => {
            const at = unmonitoredAtRef.current[album.id];
            if (at != null && at >= cutoff && album.monitored) {
              return { ...album, monitored: false };
            }
            return album;
          });
          setLibraryAlbums(deduplicateAlbums(merged));
        } catch (err) {
          console.error("Failed to refresh albums:", err);
        }
      },
      hasNewlyAdded ? 2000 : 5000,
    );
    libraryRefreshTimeoutsRef.current.add(timeoutId);
  }, [artist?.id, downloadStatusesQuery.data, libraryArtist, setLibraryAlbums]);

  useEffect(() => {
    previousDownloadStatusesRef.current = {};
  }, [libraryArtist?.id]);

  useEffect(() => {
    downloadStatusesRef.current = downloadStatuses;
  }, [downloadStatuses]);

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
          if (at != null && at >= cutoff && a.monitored) return { ...a, monitored: false };
          return a;
        });
        setLibraryAlbums(deduplicateAlbums(merged));
      } catch (err) {
        console.error("Failed to refresh albums:", err);
      }
    };
    let tick = 0;
    const interval = setInterval(() => {
      tick += 1;
      if (document.hidden) return;
      const hasActiveDownloads = Object.values(downloadStatusesRef.current).some(
        (s) =>
          s &&
          (s.status === "downloading" || s.status === "processing" || s.status === "adding"),
      );
      if (!hasActiveDownloads && tick % 4 !== 0) return;
      refreshAlbums();
    }, 30000);
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
    showRemoveDropdown,
    setShowRemoveDropdown,
    showDeleteModal,
    deleteFiles,
    setDeleteFiles: updateDeleteFilesPreference,
    deletingArtist,
    addingToLibrary,
    showAddCustomizeModal,
    setShowAddCustomizeModal,
    loadingLidarrPreferences: lidarrPreferencesQuery.isFetching,
    lidarrPreferences: lidarrPreferencesQuery.data || null,
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
    getAlbumStatus,
  };
}
