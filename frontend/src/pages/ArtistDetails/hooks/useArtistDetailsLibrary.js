import { useState, useEffect, useRef, useCallback } from "react";
import {
  getLibraryAlbums,
  getLibraryTracks,
  getReleaseGroupTracks,
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
} from "../../../utils/api";
import { deduplicateAlbums } from "../utils";
import { matchesReleaseTypeFilter } from "../utils";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";

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
  const [deleteAlbumFiles, setDeleteAlbumFiles] = useState(false);
  const [processingBulk, setProcessingBulk] = useState(false);
  const [expandedLibraryAlbum, setExpandedLibraryAlbum] = useState(null);
  const [expandedReleaseGroup, setExpandedReleaseGroup] = useState(null);
  const [albumTracks, setAlbumTracks] = useState({});
  const [loadingTracks, setLoadingTracks] = useState({});
  const [showRemoveDropdown, setShowRemoveDropdown] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deletingArtist, setDeletingArtist] = useState(false);
  const [addingToLibrary, setAddingToLibrary] = useState(false);
  const [showMonitorOptionMenu, setShowMonitorOptionMenu] = useState(false);
  const [updatingMonitor, setUpdatingMonitor] = useState(false);
  const [refreshingArtist, setRefreshingArtist] = useState(false);
  const [downloadStatuses, setDownloadStatuses] = useState({});
  const [reSearchingAlbum, setReSearchingAlbum] = useState(null);
  const [reSearchOverrides, setReSearchOverrides] = useState({});
  const reSearchOverridesRef = useRef({});
  const unmonitoredAtRef = useRef({});
  const lastWsAtRef = useRef(0);

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
    setDeleteFiles(false);
  };

  const handleDeleteCancel = () => {
    setShowDeleteModal(false);
    setDeleteFiles(false);
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
      setDeleteFiles(false);
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
        monitored: newMonitorOption !== "none",
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

  const hydrateLibraryArtist = async (lookupArtist) => {
    const fullArtist = await getLibraryArtist(
      lookupArtist.mbid || lookupArtist.foreignArtistId,
    );
    setLibraryArtist(fullArtist);
    setExistsInLibrary(true);
    await refreshLibraryArtist(
      fullArtist.mbid || fullArtist.foreignArtistId,
    );
    const albums = await getLibraryAlbums(fullArtist.id);
    setLibraryAlbums(deduplicateAlbums(albums));
    return fullArtist;
  };

  const waitForLibraryArtist = async (mbid) => {
    const attempts = 10;
    for (let i = 0; i < attempts; i++) {
      const lookup = await lookupArtistInLibrary(mbid);
      if (lookup.exists && lookup.artist) {
        return await hydrateLibraryArtist(lookup.artist);
      }
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
      ["none", "all", "future", "missing", "latest", "first"].includes(
        monitorOption,
      )
    ) {
      return monitorOption;
    }
    return libraryArtist.monitored ? "all" : "none";
  };

  const handleAddToLibrary = async () => {
    if (!artist) {
      showError("Artist information not available");
      return;
    }
    setAddingToLibrary(true);
    try {
      const defaultMonitorOption =
        appSettings?.integrations?.lidarr?.defaultMonitorOption || "none";
      const result = await addArtistToLibrary({
        foreignArtistId: artist.id,
        artistName: artist.name,
        quality: appSettings?.quality || "standard",
        rootFolderPath: appSettings?.rootFolderPath,
        monitorOption: defaultMonitorOption,
      });
      let fullArtist = null;
      if (result?.queued) {
        showSuccess(`Adding ${artist.name}...`);
        fullArtist = await waitForLibraryArtist(artist.id);
      } else {
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

  const handleRequestAlbum = async (albumId, title) => {
    setRequestingAlbum(albumId);
    let addedOptimistic = false;
    try {
      const resolveLibraryArtist = async () => {
        if (!artist) return null;
        const lookup = await lookupArtistInLibrary(artist.id);
        if (lookup.exists && lookup.artist) {
          const fullArtist = await getLibraryArtist(
            lookup.artist.mbid || lookup.artist.foreignArtistId,
          );
          setLibraryArtist(fullArtist);
          setExistsInLibrary(true);
          return fullArtist;
        }
        return libraryArtist;
      };

      if (!existsInLibrary || !libraryArtist?.id) {
        if (!artist) {
          showError("Artist information not available");
          return;
        }
        const defaultMonitorOption =
          appSettings?.integrations?.lidarr?.defaultMonitorOption || "none";
        const result = await addArtistToLibrary({
          foreignArtistId: artist.id,
          artistName: artist.name,
          quality: appSettings?.quality || "standard",
          rootFolderPath: appSettings?.rootFolderPath,
          monitorOption: defaultMonitorOption,
        });
        let fullArtist = null;
        if (result?.queued) {
          showSuccess(`Adding ${artist.name}...`);
          fullArtist = await waitForLibraryArtist(artist.id);
        } else {
          const lookup = await lookupArtistInLibrary(artist.id);
          if (lookup.exists && lookup.artist) {
            fullArtist = await hydrateLibraryArtist(lookup.artist);
          }
        }
        if (!fullArtist) {
          throw new Error("Failed to get library artist");
        }
      }

      const currentLibraryArtist = await resolveLibraryArtist();
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
          setDownloadStatuses((prev) => ({
            ...prev,
            [addedAlbum.id]: { status: "processing" },
          }));
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
            throw new Error(
              "Album not found for this artist. Please try again.",
            );
          }
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
        setLibraryAlbums((prev) =>
          prev.filter((a) => a.id !== `pending-${albumId}`),
        );
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

  const handleLibraryAlbumClick = async (releaseGroupId, libraryAlbumId) => {
    if (expandedLibraryAlbum === releaseGroupId) {
      setExpandedLibraryAlbum(null);
      return;
    }
    setExpandedLibraryAlbum(releaseGroupId);
    setExpandedReleaseGroup(null);
    const trackKey = libraryAlbumId || releaseGroupId;
    if (!albumTracks[trackKey]) {
      setLoadingTracks((prev) => ({ ...prev, [trackKey]: true }));
      try {
        const tracks = await getLibraryTracks(libraryAlbumId, releaseGroupId);
        setAlbumTracks((prev) => ({ ...prev, [trackKey]: tracks }));
      } catch (err) {
        console.error("Failed to fetch tracks:", err);
        showError("Failed to fetch track list");
      } finally {
        setLoadingTracks((prev) => ({ ...prev, [trackKey]: false }));
      }
    }
  };

  const handleReleaseGroupAlbumClick = async (
    releaseGroupId,
    libraryAlbumId,
  ) => {
    if (expandedReleaseGroup === releaseGroupId) {
      setExpandedReleaseGroup(null);
      return;
    }
    setExpandedReleaseGroup(releaseGroupId);
    setExpandedLibraryAlbum(null);
    const trackKey = libraryAlbumId || releaseGroupId;
    if (!albumTracks[trackKey]) {
      setLoadingTracks((prev) => ({ ...prev, [trackKey]: true }));
      try {
        if (libraryAlbumId) {
          const tracks = await getLibraryTracks(libraryAlbumId, releaseGroupId);
          setAlbumTracks((prev) => ({ ...prev, [trackKey]: tracks }));
        } else {
          const rg = artist?.["release-groups"]?.find(
            (r) => r.id === releaseGroupId,
          );
          const deezerId = rg?._deezerAlbumId ?? null;
          const tracks = await getReleaseGroupTracks(releaseGroupId, deezerId);
          setAlbumTracks((prev) => ({ ...prev, [trackKey]: tracks }));
        }
      } catch (err) {
        console.error("Failed to fetch tracks:", err);
        showError("Failed to fetch track list");
      } finally {
        setLoadingTracks((prev) => ({ ...prev, [trackKey]: false }));
      }
    }
  };

  const handleDeleteAlbumClick = (albumId, title) => {
    setShowDeleteAlbumModal({ id: albumId, title });
    setDeleteAlbumFiles(false);
    setAlbumDropdownOpen(null);
  };

  const handleDeleteAlbumCancel = () => {
    setShowDeleteAlbumModal(null);
    setDeleteAlbumFiles(false);
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
      setDeleteAlbumFiles(false);
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
    return (
      (album.statistics?.percentOfTracks ?? 0) > 0 ||
      (album.statistics?.sizeOnDisk ?? 0) > 0 ||
      !!downloadStatuses[album.id] ||
      (requestingAlbum &&
        (album.mbid === requestingAlbum ||
          album.foreignAlbumId === requestingAlbum))
    );
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
        label: "Searching...",
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

  const refreshAlbums = useCallback(
    async (force = false) => {
      if (!libraryArtist) return;
      if (!force && Date.now() - lastWsAtRef.current < 120000) return;
      try {
        const refreshedAlbums = await getLibraryAlbums(libraryArtist.id);
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
    },
    [libraryArtist, setLibraryAlbums],
  );

  const pollDownloadStatus = useCallback(
    async (force = false) => {
      if (!libraryAlbums.length || !libraryArtist) return;
      if (!force && Date.now() - lastWsAtRef.current < 120000) return;
      try {
        const albumIds = libraryAlbums.map((a) => a.id).filter(Boolean);
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
              setTimeout(
                async () => {
                  try {
                    await refreshAlbums(true);
                  } catch (err) {
                    console.error("Failed to refresh albums:", err);
                  }
                },
                hasNewlyAdded ? 2000 : 5000,
              );
            }
            return nextStatuses;
          });
        }
      } catch (error) {
        console.error("Failed to fetch download status:", error);
      }
    },
    [libraryAlbums, libraryArtist, refreshAlbums, requestingAlbum],
  );

  useEffect(() => {
    pollDownloadStatus(true);
    const interval = setInterval(() => pollDownloadStatus(false), 30000);
    return () => clearInterval(interval);
  }, [pollDownloadStatus]);

  useEffect(() => {
    refreshAlbums(true);
    const interval = setInterval(() => refreshAlbums(false), 60000);
    return () => clearInterval(interval);
  }, [refreshAlbums]);

  useWebSocketChannel("library", (msg) => {
    if (msg.type === "library_update") {
      lastWsAtRef.current = Date.now();
      refreshAlbums(true);
      pollDownloadStatus(true);
    }
  });

  useWebSocketChannel("queue", (msg) => {
    if (msg.type === "queue_update") {
      lastWsAtRef.current = Date.now();
      pollDownloadStatus(true);
    }
  });

  return {
    requestingAlbum,
    removingAlbum,
    albumDropdownOpen,
    setAlbumDropdownOpen,
    showDeleteAlbumModal,
    deleteAlbumFiles,
    setDeleteAlbumFiles,
    processingBulk,
    expandedLibraryAlbum,
    setExpandedLibraryAlbum,
    expandedReleaseGroup,
    setExpandedReleaseGroup,
    albumTracks,
    loadingTracks,
    showRemoveDropdown,
    setShowRemoveDropdown,
    showDeleteModal,
    deleteFiles,
    setDeleteFiles,
    deletingArtist,
    addingToLibrary,
    showMonitorOptionMenu,
    setShowMonitorOptionMenu,
    updatingMonitor,
    refreshingArtist,
    reSearchingAlbum,
    downloadStatuses,
    handleRefreshArtist,
    handleDeleteClick,
    handleDeleteCancel,
    handleDeleteConfirm,
    handleUpdateMonitorOption,
    getCurrentMonitorOption,
    handleAddToLibrary,
    handleRequestAlbum,
    handleReSearchAlbum,
    handleLibraryAlbumClick,
    handleReleaseGroupAlbumClick,
    handleDeleteAlbumClick,
    handleDeleteAlbumCancel,
    handleDeleteAlbumConfirm,
    handleMonitorAll,
    getAlbumStatus,
    isReleaseGroupDownloadedInLibrary,
  };
}
