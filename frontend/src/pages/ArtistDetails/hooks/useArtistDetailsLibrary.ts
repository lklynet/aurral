import { useMemo, useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { libraryAlbumsClient } from "../../../utils/api/clients/libraryAlbums.ts";
import { libraryArtistsClient } from "../../../utils/api/clients/libraryArtists.ts";
import {
  getLibraryAlbums,
  getLibraryArtist,
  triggerAlbumSearch,
  getDownloadStatus,
  addArtistToLibrary,
  lookupArtistInLibrary,
  requestAlbumFromSearch,
  setAurralAlbumMonitoring,
  settleLibraryOwnerConflict,
  type AlbumRequestResult,
  type AurralMonitoringResult,
} from "../../../utils/api/endpoints/library.ts";
import {
  buildAlbumRequestPayload,
  buildArtistAddPayload,
  canSearchLibraryAlbum,
  resolveAlbumManager,
} from "../../../utils/libraryDestination.ts";
import { describeArtistAdd } from "../../../utils/artistMonitoring.ts";
import { describeAlbumRequestResult } from "../../../utils/albumAddAction.ts";
import { buildAurralAlbumRetryPayload } from "../../../utils/aurralAlbumStatus.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import {
  deduplicateAlbums,
  getApiErrorMessage,
  getApiErrorText,
  getDownloadStatusLabel,
} from "../utils";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";
import { asApiError } from "../../../utils/api/core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { DownloadStatusEntry } from "../../../../../backend/services/websocketService.ts";
import type { LibraryArtistRecord, useArtistDetailsStream } from "./useArtistDetailsStream.ts";
import type { useToast } from "../../../contexts/ToastContext.tsx";
import type { useLibraryDestination } from "../../../hooks/useLibraryDestination.ts";

const DELETE_FILES_PREFERENCE_KEY = "aurral:library-delete-files";

type ArtistDetailsStream = ReturnType<typeof useArtistDetailsStream>;
export type ArtistDetailsLibrary = ReturnType<typeof useArtistDetailsLibrary>;
type ToastFn = ReturnType<typeof useToast>["showSuccess"];
type OwnerConflict = NonNullable<ReturnType<typeof settleLibraryOwnerConflict>>;
export type DownloadStatus = Partial<DownloadStatusEntry> & Pick<DownloadStatusEntry, "status">;
export type DownloadStatuses = Record<string, DownloadStatus>;
type DeleteAlbumTarget = {
  id: string | null | undefined;
  title: string | null | undefined;
  managedBy: string | null;
};
export type LibraryAlbumId = string | number;
type LibraryAlbums = ArtistDetailsStream["libraryAlbums"];
export type LibraryAlbum = LibraryAlbums[number];
type ArtistMonitoring = InferResponseType<
  (typeof libraryArtistsClient.artists)[":mbid"]["monitoring"]["$get"],
  200
>;
type AlbumSearchResult =
  | AlbumRequestResult
  | (AurralMonitoringResult & { status?: undefined; albumStatus?: undefined })
  | null;
type LidarrPreferences = InferResponseType<
  (typeof usersClient.me)["lidarr-preferences"]["$get"],
  200
>;
type ArtistAddLidarrOptions = NonNullable<
  Parameters<typeof buildArtistAddPayload>[0]["lidarrOptions"]
>;

type ArtistDetailsLibraryOptions = Pick<
  ArtistDetailsStream,
  | "artist"
  | "libraryArtist"
  | "setLibraryArtist"
  | "libraryAlbums"
  | "setLibraryAlbums"
  | "existsInLibrary"
  | "setExistsInLibrary"
  | "appSettings"
> & {
  showSuccess: ToastFn;
  showError: ToastFn;
  showInfo: ToastFn;
  libraryDestination: ReturnType<typeof useLibraryDestination>;
};

const invalidateLibraryQueries = (
  mbid: string | null = null,
  artistId: string | number | null = null,
) => {
  const queryKeysToInvalidate = [
    queryKeys.libraryPagePrefix,
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

const writeDeleteFilesPreference = (value: boolean) => {
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
  showInfo,
  libraryDestination,
}: ArtistDetailsLibraryOptions) {
  const [ownerConflicts, setOwnerConflicts] = useState<Record<string, OwnerConflict>>({});
  const [requestingAlbum, setRequestingAlbum] = useState<string | null>(null);
  const [removingAlbum, setRemovingAlbum] = useState<string | null | undefined>(null);
  const [albumDropdownOpen, setAlbumDropdownOpen] = useState<string | null | undefined>(null);
  const [showDeleteAlbumModal, setShowDeleteAlbumModal] = useState<DeleteAlbumTarget | null>(null);
  const [deleteAlbumFiles, setDeleteAlbumFilesState] = useState(() => readDeleteFilesPreference());
  const [refreshingArtist, setRefreshingArtist] = useState(false);
  const [reSearchingAlbum, setReSearchingAlbum] = useState<LibraryAlbumId | null>(null);
  const [reSearchingMissingAlbums, setReSearchingMissingAlbums] = useState(false);
  const [reSearchOverrides, setReSearchOverrides] = useState<Record<string, number>>({});
  const [showAddCustomizeModal, setShowAddCustomizeModal] = useState(false);
  const [customizeAddError, setCustomizeAddError] = useState<string | null>(null);
  const [customizeRootFolderPath, setCustomizeRootFolderPath] = useState("");
  const [customizeQualityProfileId, setCustomizeQualityProfileId] = useState("");
  const [customizeTagId, setCustomizeTagId] = useState("");
  const [customizeMonitorOption, setCustomizeMonitorOption] = useState("");
  const reSearchOverridesRef = useRef<Record<string, number>>({});
  const previousDownloadStatusesRef = useRef<DownloadStatuses>({});
  const unmonitoredAtRef = useRef<Record<string, number>>({});
  const deletedAlbumAtRef = useRef<Record<string, number>>({});
  const libraryAlbumIdsRef = useRef<string[]>([]);
  const libraryAlbumsRef = useRef(libraryAlbums);
  const { isConnected: downloadStatusWsConnected } = useWebSocketChannel("downloads", (msg) => {
    if (msg?.type !== "download_statuses") return;
    const albumIds = libraryAlbumIdsRef.current;
    if (!albumIds.length) return;
    const incoming = msg.statuses || {};
    const next: DownloadStatuses = {};
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
    queryClient.setQueryData(
      queryKeys.downloadStatus(albumIds),
      (previous: DownloadStatuses = {}) => ({
        ...previous,
        ...next,
      }),
    );
  });
  const lidarrPreferencesQuery = useQuery({
    queryKey: queryKeys.lidarrPreferences("current"),
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["lidarr-preferences"].$get({}, { init: { signal } })),
    enabled: false,
    staleTime: 30_000,
  });
  const downloadStatusIds = useMemo(
    () => libraryAlbums.map((album) => String(album.id)).filter(Boolean),
    [libraryAlbums],
  );
  const downloadStatusesQuery = useQuery<DownloadStatuses>({
    queryKey: queryKeys.downloadStatus(downloadStatusIds),
    queryFn: ({ signal }) => getDownloadStatus(downloadStatusIds, { signal, bypassCache: true }),
    enabled: Boolean(libraryArtist && downloadStatusIds.length),
    staleTime: 4_000,
    refetchInterval: (currentQuery) => {
      if (downloadStatusWsConnected || (typeof document !== "undefined" && document.hidden)) {
        return false;
      }
      const statuses: DownloadStatuses = currentQuery.state.data || {};
      const hasActiveDownloads = Object.values(statuses).some(
        (status) => status && ["downloading", "processing", "adding"].includes(status.status),
      );
      return hasActiveDownloads ? 15_000 : false;
    },
  });
  const downloadStatusSnapshotRef = useRef<{ key: string; statuses: DownloadStatuses }>({
    key: "",
    statuses: {},
  });
  const downloadStatusSnapshot = useMemo(() => {
    const statuses: DownloadStatuses = downloadStatusesQuery.data || {};
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
  const libraryAlbumsQuery = useQuery<LibraryAlbums>({
    queryKey: libraryAlbumsQueryKey,
    queryFn: ({ signal }) =>
      getLibraryAlbums(libraryArtist!.id!, {
        signal,
        managedBy: libraryArtist!.managedBy || null,
      }),
    enabled: Boolean(libraryArtist?.id),
    initialData: libraryAlbums,
    initialDataUpdatedAt: 0,
    staleTime: 0,
    refetchInterval: () => {
      if (typeof document !== "undefined" && document.hidden) return false;
      const statuses: DownloadStatuses = downloadStatusesQuery.data || {};
      const hasActiveDownloads = Object.values(statuses).some(
        (status) => status && ["downloading", "processing", "adding"].includes(status.status),
      );
      return hasActiveDownloads ? 30_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const { refetch: refetchLibraryAlbums } = libraryAlbumsQuery;
  const refreshArtistMutation = useMutation({
    mutationFn: (mbid: string | null | undefined) =>
      parseResponse(
        libraryArtistsClient.artists[":mbid"].refresh.$post({
          param: { mbid: encodeURIComponent(String(mbid)) },
        }),
      ),
  });
  const addArtistMutation = useMutation({
    mutationFn: addArtistToLibrary,
    onMutate: async (payload) => {
      const queryKey = queryKeys.artistMonitoring(payload.foreignArtistId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      const optimistic = queryClient.setQueryData<ArtistMonitoring>(queryKey, (current) =>
        current
          ? {
              ...current,
              added: true,
              monitorOption: payload.monitorOption || current.monitorOption || "none",
            }
          : current,
      );
      return { queryKey, previous, optimistic };
    },
    onError: (_error, _payload, context) => {
      if (context && queryClient.getQueryData(context.queryKey) === context.optimistic) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSuccess: () => invalidateLibraryQueries(),
    onSettled: (_data, _error, payload) =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.artistMonitoring(payload.foreignArtistId),
      }),
  });
  const requestAlbumMutation = useMutation({
    mutationFn: requestAlbumFromSearch,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryAlbumLookupPrefix }),
  });
  const updateAlbumMutation = useMutation({
    mutationFn: ({ id, data }: { id: string | number; data: { monitored?: boolean } }) =>
      parseResponse(
        libraryAlbumsClient.albums[":id"].$put({
          param: { id: encodeURIComponent(id) },
          json: data,
        }),
      ),
    onSuccess: () => invalidateLibraryQueries(),
  });
  const deleteAlbumMutation = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: string | number; deleteFiles: boolean }) =>
      parseResponse(
        libraryAlbumsClient.albums[":id"].$delete({
          param: { id: encodeURIComponent(id) },
          query: { deleteFiles: String(deleteFiles) },
        }),
      ),
    onSuccess: () => invalidateLibraryQueries(),
  });
  const deleteAurralAlbumMutation = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: string | number; deleteFiles: boolean }) =>
      parseResponse(
        libraryAlbumsClient.albums.aurral[":canonicalId"].$delete({
          param: { canonicalId: encodeURIComponent(id) },
          query: { deleteFiles: String(deleteFiles) },
        }),
      ),
    onSuccess: () => invalidateLibraryQueries(),
  });
  const searchAlbumMutation = useMutation({
    mutationFn: triggerAlbumSearch,
  });
  const downloadStatuses = useMemo(() => {
    const statuses: DownloadStatuses = downloadStatusesQuery.data || {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(statuses).map(([albumId, status]) => {
        const overrideAt = reSearchOverrides[albumId];
        if (overrideAt != null && status?.status === "failed" && now - overrideAt < 5 * 60 * 1000) {
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

  const updateDeleteFilesPreference = (value: boolean) => {
    writeDeleteFilesPreference(value);
    setDeleteAlbumFilesState(value);
  };

  const handleRefreshArtist = async () => {
    const mbid = libraryArtist?.mbid || libraryArtist?.foreignArtistId;
    if (!mbid) return;
    setRefreshingArtist(true);
    try {
      await refreshArtistMutation.mutateAsync(mbid);
      setTimeout(async () => {
        try {
          const refreshedArtist = await getLibraryArtist(mbid, { bypassCache: true });
          setLibraryArtist(refreshedArtist);
          await refetchLibraryAlbums();
          showSuccess("Artist updated.");
        } catch (err) {
          console.error("Failed to refresh artist data:", err);
          showError("Failed to refresh artist data");
        } finally {
          setRefreshingArtist(false);
        }
      }, 2000);
    } catch (err) {
      showError(`Failed to refresh artist: ${asApiError(err)?.message}`);
      setRefreshingArtist(false);
    }
  };

  const reloadLibraryState = async () => {
    const mbid = artist?.id || libraryArtist?.mbid;
    if (!mbid) return;
    await invalidateLibraryQueries(mbid);
    const lookup = await lookupArtistInLibrary(mbid, { bypassCache: true });
    if (lookup.exists && lookup.artist) {
      await resolveLookupArtist(lookup.artist, { refresh: false, hydrateAlbums: true });
    } else {
      setExistsInLibrary(false);
      setLibraryArtist(null);
      setLibraryAlbums([]);
    }
  };

  const resolveLookupArtist = async (
    lookupArtist: LibraryArtistRecord | null,
    { refresh = true, hydrateAlbums = true }: { refresh?: boolean; hydrateAlbums?: boolean } = {},
  ) => {
    if (!lookupArtist) return null;
    const lookupMbid = lookupArtist.mbid || lookupArtist.foreignArtistId;
    let fullArtist: LibraryArtistRecord;
    try {
      fullArtist = await getLibraryArtist(lookupMbid, { bypassCache: true });
    } catch {
      fullArtist = {
        ...lookupArtist,
        foreignArtistId: lookupArtist.foreignArtistId || lookupArtist.mbid!,
      };
    }
    if (!fullArtist?.id) return null;
    setLibraryArtist(fullArtist);
    setExistsInLibrary(true);
    if (refresh) {
      await refreshArtistMutation.mutateAsync(fullArtist.mbid || fullArtist.foreignArtistId);
    }
    if (hydrateAlbums) {
      const albums = await getLibraryAlbums(fullArtist.id, {
        bypassCache: true,
        managedBy: fullArtist.managedBy || null,
      });
      setLibraryAlbums(deduplicateAlbums(albums));
    }
    return fullArtist;
  };

  const hydrateLibraryArtist = async (lookupArtist: LibraryArtistRecord) => {
    return await resolveLookupArtist(lookupArtist, {
      refresh: true,
      hydrateAlbums: true,
    });
  };

  const resolveArtistFromAddResponse = async (
    result: Awaited<ReturnType<typeof addArtistToLibrary>> | null,
    { refresh = true, hydrateAlbums = true }: { refresh?: boolean; hydrateAlbums?: boolean } = {},
  ) => {
    if (!result?.artist) return null;
    return await resolveLookupArtist(result.artist, {
      refresh,
      hydrateAlbums,
    });
  };

  const applyCustomizeDefaults = (preferences: LidarrPreferences | undefined) => {
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
    setCustomizeMonitorOption("");
  };

  const loadLidarrPreferenceState = async ({ force = false } = {}) => {
    if (!force && lidarrPreferencesQuery.data) return lidarrPreferencesQuery.data;
    const { data } = await lidarrPreferencesQuery.refetch({ throwOnError: true });
    return data;
  };

  const handleOpenAddCustomizeModal = async () => {
    setCustomizeAddError(null);
    setShowAddCustomizeModal(true);
    try {
      const preferences = await loadLidarrPreferenceState();
      applyCustomizeDefaults(preferences);
    } catch (err) {
      setShowAddCustomizeModal(false);
      showError(getApiErrorMessage(err) || "Failed to load Lidarr preferences");
    }
  };

  const addArtistWithOptions = async (
    managedBy: string,
    lidarrOptions: ArtistAddLidarrOptions = {},
    monitorOption: string | null = null,
  ) => {
    if (!artist) {
      showError("Artist information not available");
      return;
    }
    const artistMbid = artist.id;
    const artistName = artist.name;
    if (addArtistMutation.isPending) return false;
    setCustomizeAddError(null);
    try {
      const result = await addArtistMutation.mutateAsync(
        buildArtistAddPayload({
          artistMbid,
          artistName,
          quality: appSettings?.quality || "standard",
          managedBy,
          lidarrOptions,
          ...(monitorOption ? { monitorOption } : {}),
        }),
      );
      let fullArtist = await resolveArtistFromAddResponse(result, {
        refresh: true,
        hydrateAlbums: true,
      });
      if (!fullArtist) {
        const lookup = await lookupArtistInLibrary(artistMbid, { bypassCache: true });
        if (lookup.exists && lookup.artist) {
          fullArtist = await hydrateLibraryArtist(lookup.artist);
        }
      }
      if (!fullArtist) {
        throw new Error("Artist is taking longer than expected to add");
      }
      showSuccess(
        describeArtistAdd({
          name: artistName,
          monitorOption,
        }),
      );
      return true;
    } catch (err) {
      const conflict = settleLibraryOwnerConflict(err);
      if (conflict) {
        try {
          const lookup = await lookupArtistInLibrary(artistMbid, { bypassCache: true });
          if (lookup.exists && lookup.artist) {
            await resolveLookupArtist(lookup.artist, { refresh: false, hydrateAlbums: true });
          }
        } catch {}
        setShowAddCustomizeModal(false);
        showInfo(`${artist.name}: ${conflict.message}`);
        return false;
      }
      const message = `Could not add ${artist.name}. Nothing was added. ${
        getApiErrorMessage(err) || "Try again."
      }`;
      if (showAddCustomizeModal) setCustomizeAddError(message);
      else showError(message);
      return false;
    }
  };

  const handleCustomizeAddToLibrary = async () => {
    const success = await addArtistWithOptions(
      "lidarr",
      {
        rootFolderPath: customizeRootFolderPath || null,
        qualityProfileId: customizeQualityProfileId ? Number(customizeQualityProfileId) : null,
        tagId: customizeTagId ? Number(customizeTagId) : null,
      },
      customizeMonitorOption || null,
    );
    if (success) {
      setShowAddCustomizeModal(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.artistMonitoring(artist?.id) });
    }
    return success;
  };

  const handleRequestAlbum = async (
    albumId: string,
    title: string,
    managedBy: string = libraryDestination.primary,
  ) => {
    if (requestingAlbum) return;
    setRequestingAlbum(albumId);
    try {
      if (!artist?.id || !artist?.name) {
        throw new Error("Artist information not available");
      }
      const artistMbid = artist.id;

      const result = await requestAlbumMutation.mutateAsync(
        buildAlbumRequestPayload({
          albumMbid: albumId,
          albumName: title,
          artistMbid: artist.id,
          artistName: artist.name,
          managedBy,
          triggerSearch: true,
        }),
      );
      const addedArtist = result?.artist;
      const addedAlbum = result?.album;
      if (!addedArtist?.id || !addedAlbum?.id) {
        throw new Error("The album request did not complete");
      }
      const addedAlbumId = addedAlbum.id;
      const addedArtistId = addedArtist.id;

      setLibraryArtist((previous) => {
        const foreignArtistId = addedArtist.foreignArtistId || addedArtist.mbid || artistMbid;
        if (addedArtist.managedBy) {
          return { ...previous, ...addedArtist, id: addedArtistId, foreignArtistId };
        }
        return {
          ...previous,
          ...addedArtist,
          id: addedArtistId,
          managedBy: previous?.managedBy || null,
          foreignArtistId,
        };
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
            id: addedAlbumId,
            managedBy: addedAlbum.managedBy || result?.managedBy || managedBy,
            mbid: addedAlbum.mbid || addedAlbum.foreignAlbumId || albumId,
            foreignAlbumId: addedAlbum.foreignAlbumId || addedAlbum.mbid || albumId,
            monitored: true,
          },
        ]),
      );
      const nextDownloadStatusIds = [
        ...new Set([...downloadStatusIds, String(addedAlbumId)].filter(Boolean)),
      ];
      queryClient.setQueryData(
        queryKeys.downloadStatus(nextDownloadStatusIds),
        (previous: DownloadStatuses = {}) => {
          const next = { ...previous };
          delete next[`pending-${albumId}`];
          next[addedAlbumId] = { status: result.status || "searching" };
          return next;
        },
      );
      const outcome = describeAlbumRequestResult(result, title);
      (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
    } catch (err) {
      const conflict = settleLibraryOwnerConflict(err);
      if (conflict) {
        setOwnerConflicts((previous) => ({ ...previous, [albumId]: conflict }));
        showInfo(`${title}: ${conflict.message}`);
        return;
      }
      showError(
        `Could not request ${title}. Nothing was added. ${getApiErrorMessage(err) || "Try again."}`,
      );
    } finally {
      setRequestingAlbum(null);
    }
  };

  const lidarrConnected = libraryDestination?.primary === "lidarr";

  const searchLibraryAlbum = async (album: LibraryAlbum): Promise<AlbumSearchResult> => {
    if (resolveAlbumManager(album) === "aurral") {
      if (!album.monitored) return setAurralAlbumMonitoring(album.id, true);
      return requestAlbumFromSearch(
        buildAurralAlbumRetryPayload({
          album,
          artist: {
            mbid: album.artistMbid || libraryArtist?.foreignArtistId || libraryArtist?.mbid,
            name: album.artistName || libraryArtist?.artistName,
          },
        }),
      );
    }
    if (!album.monitored) {
      await updateAlbumMutation.mutateAsync({ id: album.id, data: { ...album, monitored: true } });
    }
    await searchAlbumMutation.mutateAsync(album.id);
    return null;
  };

  const isBlockedSearch = (result: Awaited<ReturnType<typeof searchLibraryAlbum>>) =>
    result?.status === "blocked" || result?.albumStatus?.status === "blocked";

  const undoReSearchOverrides = (albumIds: LibraryAlbumId[]) => {
    const nextOverrides = { ...reSearchOverridesRef.current };
    for (const albumId of albumIds) delete nextOverrides[String(albumId)];
    reSearchOverridesRef.current = nextOverrides;
    setReSearchOverrides(nextOverrides);
    queryClient.invalidateQueries({ queryKey: queryKeys.downloadStatus(downloadStatusIds) });
  };

  const handleReSearchAlbum = async (
    libraryAlbumId: LibraryAlbumId,
    title: string | null | undefined,
  ) => {
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
      queryClient.setQueryData(
        queryKeys.downloadStatus(downloadStatusIds),
        (previous: DownloadStatuses = {}) => ({
          ...previous,
          [overrideKey]: { status: "searching" },
        }),
      );
      const result = await searchLibraryAlbum(album);
      setLibraryAlbums((prev) =>
        prev.map((a) => (a.id === libraryAlbumId ? { ...a, monitored: true } : a)),
      );
      if (isBlockedSearch(result)) {
        undoReSearchOverrides([libraryAlbumId]);
        showInfo(describeAlbumRequestResult(result, title).message);
        return;
      }
      showSuccess(`Search triggered for ${title}`);
    } catch (err) {
      showError(
        `Failed to re-search album: ${getApiErrorText(err, "message") || asApiError(err)?.message}`,
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
        if (!canSearchLibraryAlbum(album, { lidarrConnected })) return false;
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

      const results = await Promise.all(eligibleAlbums.map(searchLibraryAlbum));
      const blockedAlbums = eligibleAlbums.filter((_album, index) =>
        isBlockedSearch(results[index]),
      );

      setLibraryAlbums((prev) =>
        prev.map((album) =>
          eligibleAlbums.some((candidate) => candidate.id === album.id)
            ? { ...album, monitored: true }
            : album,
        ),
      );

      if (blockedAlbums.length > 0) undoReSearchOverrides(blockedAlbums.map((album) => album.id));
      const searched = eligibleAlbums.length - blockedAlbums.length;
      if (searched === 0) {
        showInfo("Nothing is downloading. Open an album to see why.");
        return;
      }
      showSuccess(`Triggered search for ${searched} missing download${searched === 1 ? "" : "s"}`);
    } catch (err) {
      showError(
        `Failed to re-search missing downloads: ${getApiErrorText(err, "message") || asApiError(err)?.message}`,
      );
    } finally {
      setReSearchingMissingAlbums(false);
    }
  };

  const handleDeleteAlbumClick = (
    albumId: string | null | undefined,
    title: string | null | undefined,
  ) => {
    const managedBy = libraryAlbums.find((a) => a.foreignAlbumId === albumId)?.managedBy || null;
    setShowDeleteAlbumModal({ id: albumId, title, managedBy });
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
      if (libraryAlbum.managedBy === "aurral") {
        await deleteAurralAlbumMutation.mutateAsync({
          id: libraryAlbum.canonicalId || libraryAlbum.id,
          deleteFiles: deleteAlbumFiles,
        });
        deletedAlbumAtRef.current[libraryAlbum.id] = Date.now();
        setLibraryAlbums((prev) => prev.filter((a) => a.id !== libraryAlbum.id));
        showSuccess(
          `Removed ${title} from library${deleteAlbumFiles ? " and deleted its files" : ""}`,
        );
      } else if (deleteAlbumFiles) {
        await deleteAlbumMutation.mutateAsync({ id: libraryAlbum.id, deleteFiles: true });
        deletedAlbumAtRef.current[libraryAlbum.id] = Date.now();
        setLibraryAlbums((prev) => prev.filter((a) => a.id !== libraryAlbum.id));
        showSuccess(`Deleted ${title} and files.`);
      } else {
        const setMonitored = (monitored: boolean) =>
          setLibraryAlbums((prev) =>
            prev.map((a) => (a.id === libraryAlbum.id ? { ...a, monitored } : a)),
          );
        unmonitoredAtRef.current[libraryAlbum.id] = Date.now();
        setMonitored(false);
        setShowDeleteAlbumModal(null);
        try {
          await updateAlbumMutation.mutateAsync({
            id: libraryAlbum.id,
            data: { monitored: false },
          });
        } catch (err) {
          delete unmonitoredAtRef.current[libraryAlbum.id];
          setMonitored(libraryAlbum.monitored);
          throw err;
        }
        showSuccess(`Stopped monitoring ${title}`);
      }
      setShowDeleteAlbumModal(null);
    } catch (err) {
      const action =
        showDeleteAlbumModal.managedBy === "aurral"
          ? "remove"
          : deleteAlbumFiles
            ? "delete"
            : "unmonitor";
      showError(
        `Could not ${action} ${title}. ${action === "unmonitor" ? "Nothing changed." : "Review the album before trying again."} ${
          getApiErrorMessage(err) || ""
        }`.trim(),
      );
    } finally {
      setRemovingAlbum(null);
    }
  };

  const getAlbumStatus = (releaseGroupId: string) => {
    const ownerConflict = ownerConflicts[releaseGroupId];
    if (ownerConflict) {
      return { status: "managed", label: ownerConflict.label, ownerConflict };
    }
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
        partial: (album.statistics?.percentOfTracks ?? 0) < 100,
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
      return {
        status: effectiveStatus.status,
        label: getDownloadStatusLabel(effectiveStatus.status),
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
      label: "Not monitored",
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
        statuses[albumId]?.status === "added" && previousStatuses[albumId]?.status !== "added",
    );
    const hasActiveDownloads = Object.values(statuses).some(
      (status) => status && ["downloading", "processing", "adding"].includes(status.status),
    );
    if (!hasNewlyAdded && !hasActiveDownloads) return undefined;

    const timeoutId = setTimeout(
      () => {
        void refetchLibraryAlbums().catch(() => {});
      },
      hasNewlyAdded ? 2000 : 5000,
    );
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
    reloadLibraryState,
    addingToLibrary: addArtistMutation.isPending,
    showAddCustomizeModal,
    customizeAddError,
    setShowAddCustomizeModal,
    loadingLidarrPreferences: lidarrPreferencesQuery.isFetching,
    lidarrPreferences: lidarrPreferencesQuery.data || null,
    customizeRootFolderPath,
    setCustomizeRootFolderPath,
    customizeQualityProfileId,
    setCustomizeQualityProfileId,
    customizeTagId,
    setCustomizeTagId,
    customizeMonitorOption,
    setCustomizeMonitorOption,
    refreshingArtist,
    reSearchingAlbum,
    reSearchingMissingAlbums,
    downloadStatuses,
    handleRefreshArtist,
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
