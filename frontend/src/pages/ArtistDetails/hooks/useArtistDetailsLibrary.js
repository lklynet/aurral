import { useMemo, useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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

const invalidateLibraryQueries = (mbid = null, artistId = null) => {
  const queryKeysToInvalidate = [
    queryKeys.libraryCanonicalPrefix,
    queryKeys.libraryViewPrefix,
    queryKeys.libraryAlbumsPrefix,
    queryKeys.libraryAlbumLookupPrefix,
  ];
  if (mbid) {
    queryKeysToInvalidate.push(
      queryKeys.libraryArtist(mbid),
      queryKeys.libraryLookup(mbid),
      queryKeys.libraryLookupDetails(mbid),
    );
  }
  if (artistId != null) queryKeysToInvalidate.push(queryKeys.libraryAlbums(artistId));
  return Promise.all(
    queryKeysToInvalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
};

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
  const [showMonitorOptionMenu, setShowMonitorOptionMenu] = useState(false);
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
  const unmonitoredAtRef = useRef({});
  const deletedAlbumAtRef = useRef({});
  const libraryAlbumIdsRef = useRef([]);
  const libraryAlbumsRef = useRef(libraryAlbums);
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
  const downloadStatusSnapshotRef = useRef({ key: "", statuses: {} });
  const downloadStatusSnapshot = useMemo(() => {
    const statuses = downloadStatusesQuery.data || {};
    const key = JSON.stringify(
      Object.entries(statuses)
        .map(([albumId, status]) => [albumId, status?.status || ""])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (downloadStatusSnapshotRef.current.key === key) return downloadStatusSnapshotRef.current;
    const next = { key, statuses };
    downloadStatusSnapshotRef.current = next;
    return next;
  }, [downloadStatusesQuery.data]);
  const libraryAlbumsQueryKey = queryKeys.libraryAlbums(libraryArtist?.id);
  const libraryAlbumsQuery = useQuery({
    queryKey: libraryAlbumsQueryKey,
    queryFn: ({ signal }) => getLibraryAlbums(libraryArtist.id, { signal }),
    enabled: Boolean(libraryArtist?.id),
    initialData: libraryAlbums,
    initialDataUpdatedAt: 0,
    staleTime: 0,
    refetchInterval: () => {
      if (typeof document !== "undefined" && document.hidden) return false;
      const statuses = downloadStatusesQuery.data || {};
      const hasActiveDownloads = Object.values(statuses).some(
        (status) =>
          status &&
          ["downloading", "processing", "adding"].includes(status.status),
      );
      return hasActiveDownloads ? 30_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const { refetch: refetchLibraryAlbums } = libraryAlbumsQuery;
  const refreshArtistMutation = useMutation({ mutationFn: refreshLibraryArtist });
  const deleteArtistMutation = useMutation({
    mutationFn: ({ mbid, deleteFiles }) => deleteArtistFromLibrary(mbid, deleteFiles),
    onSuccess: (_result, { mbid }) => invalidateLibraryQueries(mbid),
  });
  const updateArtistMutation = useMutation({
    mutationFn: ({ mbid, data }) => updateLibraryArtist(mbid, data),
    onSuccess: (_result, { mbid }) => invalidateLibraryQueries(mbid),
  });
  const addArtistMutation = useMutation({
    mutationFn: addArtistToLibrary,
    onSuccess: () => invalidateLibraryQueries(),
  });
  const requestAlbumMutation = useMutation({
    mutationFn: requestAlbumFromSearch,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryAlbumLookupPrefix }),
  });
  const updateAlbumMutation = useMutation({
    mutationFn: ({ id, data }) => updateLibraryAlbum(id, data),
    onSuccess: () => invalidateLibraryQueries(),
  });
  const deleteAlbumMutation = useMutation({
    mutationFn: ({ id, deleteFiles }) => deleteAlbumFromLibrary(id, deleteFiles),
    onSuccess: () => invalidateLibraryQueries(),
  });
  const searchAlbumMutation = useMutation({
    mutationFn: triggerAlbumSearch,
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
    libraryAlbumsRef.current = libraryAlbums;
    libraryAlbumIdsRef.current = libraryAlbums.map((album) => String(album.id)).filter(Boolean);
  }, [libraryAlbums]);

  useEffect(() => {
    const cutoff = Date.now() - 120000;
    Object.entries(deletedAlbumAtRef.current).forEach(([albumId, deletedAt]) => {
      if (deletedAt < cutoff) delete deletedAlbumAtRef.current[albumId];
    });
    if (!libraryArtist?.id || !Array.isArray(libraryAlbumsQuery.data)) return;
    const merged = libraryAlbumsQuery.data
      .filter((album) => deletedAlbumAtRef.current[album.id] == null)
      .map((album) => {
        const unmonitoredAt = unmonitoredAtRef.current[album.id];
        if (unmonitoredAt != null && unmonitoredAt >= cutoff && album.monitored) {
          return { ...album, monitored: false };
        }
        return album;
      });
    setLibraryAlbums(deduplicateAlbums(merged));
  }, [libraryAlbumsQuery.data, libraryArtist?.id, setLibraryAlbums]);

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
      await refreshArtistMutation.mutateAsync(mbid);
      setTimeout(async () => {
        try {
          const refreshedArtist = await getLibraryArtist(mbid, { bypassCache: true });
          setLibraryArtist(refreshedArtist);
          await refetchLibraryAlbums();
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
    try {
      await deleteArtistMutation.mutateAsync({ mbid: libraryArtist.mbid, deleteFiles });
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
    }
  };

  const handleUpdateMonitorOption = async (newMonitorOption) => {
    if (!libraryArtist?.id) return;
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
      await updateArtistMutation.mutateAsync({ mbid: libraryArtist.mbid, data: updatedArtist });
      const refreshedArtist = await getLibraryArtist(libraryArtist.mbid, { bypassCache: true });
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
      fullArtist = await getLibraryArtist(lookupMbid, { bypassCache: true });
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
      await refreshArtistMutation.mutateAsync(fullArtist.mbid || fullArtist.foreignArtistId);
    }
    if (hydrateAlbums) {
      const albums = await getLibraryAlbums(fullArtist.id, { bypassCache: true });
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
    try {
      const result = await addArtistMutation.mutateAsync({
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
        const lookup = await lookupArtistInLibrary(artist.id, { bypassCache: true });
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

      const result = await requestAlbumMutation.mutateAsync({
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
        await updateAlbumMutation.mutateAsync({
          id: libraryAlbumId,
          data: { ...album, monitored: true },
        });
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
      await searchAlbumMutation.mutateAsync(libraryAlbumId);
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
          await updateAlbumMutation.mutateAsync({
            id: album.id,
            data: { ...album, monitored: true },
          });
        }
      }

      setLibraryAlbums((prev) =>
        prev.map((album) =>
          eligibleAlbums.some((candidate) => candidate.id === album.id)
            ? { ...album, monitored: true }
            : album,
        ),
      );

      await Promise.all(eligibleAlbums.map((album) => searchAlbumMutation.mutateAsync(album.id)));

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
        await deleteAlbumMutation.mutateAsync({ id: libraryAlbum.id, deleteFiles: true });
        deletedAlbumAtRef.current[libraryAlbum.id] = Date.now();
        setLibraryAlbums((prev) => prev.filter((a) => a.id !== libraryAlbum.id));
        showSuccess(`Successfully deleted ${title} and files`);
      } else {
        await updateAlbumMutation.mutateAsync({
          id: libraryAlbum.id,
          data: { monitored: false },
        });
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
    const { statuses } = downloadStatusSnapshot;
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
  }, [downloadStatusSnapshot, libraryArtist, requestingAlbum]);

  useEffect(() => {
    const { statuses } = downloadStatusSnapshot;
    const previousStatuses = previousDownloadStatusesRef.current;
    previousDownloadStatusesRef.current = statuses;
    if (!libraryArtist?.id || !Object.keys(statuses).length) return undefined;

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
    if (!hasNewlyAdded && !hasActiveDownloads) return undefined;

    const timeoutId = setTimeout(() => {
      void refetchLibraryAlbums().catch(() => {});
    }, hasNewlyAdded ? 2000 : 5000);
    return () => clearTimeout(timeoutId);
  }, [downloadStatusSnapshot, libraryArtist?.id, refetchLibraryAlbums]);

  useEffect(() => {
    previousDownloadStatusesRef.current = {};
  }, [libraryArtist?.id]);

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
    deletingArtist: deleteArtistMutation.isPending,
    addingToLibrary: addArtistMutation.isPending,
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
    updatingMonitor: updateArtistMutation.isPending,
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
