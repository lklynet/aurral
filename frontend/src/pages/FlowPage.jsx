import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { Check, Loader2, Play, FilePlus2, Download, Trash2, Search, RefreshCw, ClipboardCopy, ListMusic } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  getFlowJobs,
  createFlow,
  updateFlow,
  deleteFlow,
  createSharedPlaylist,
  addSharedPlaylistTracks,
  convertFlowToStaticPlaylist,
  deleteSharedPlaylist,
  updateSharedPlaylist,
  deleteSharedPlaylistTrack,
  setFlowEnabled,
  startFlowPlaylist,
  getFlowTrackStreamUrl,
  getFlowArtworkUrl,
  uploadFlowArtwork,
  deleteFlowArtwork,
  generateFlowArtwork,
  reSearchSharedPlaylistTrack,
  reSearchFlowTrack,
  reSearchMissingSharedPlaylistTracks,
  searchTrackUpgrade,
  searchPlaylistUpgrades,
  syncSharedPlaylistImport,
  getFlowLidarrImportListUrl,
} from "../utils/api/endpoints/playlists.js";
import { CreatePlaylistModal, RenamePlaylistModal } from "../components/PlaylistModals";
import PillToggle from "../components/PillToggle";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useFlowStatus } from "./flows/useFlowStatus";
import {
  formatTrackCountLabel,
  formatFlowLastRun,
  getFlowDisplayTrackCount,
  getSharedPlaylistTrackCount,
  isReleaseRadarFlow,
  isEditorialFlow,
} from "./flows/flowStats";
import { getPlaylistRunActivity } from "./flows/flowRunActivity";
import {
  PlaylistLibraryItem,
  PlaylistDetailHero,
  FlowDetailTabs,
  FlowLibraryCreateMenu,
  LibrarySidebarToggleIcon,
} from "./flows/FlowPlaylistUI";
import { FlowTracksPanel } from "./flows/flowComponents/flowTrackComponents.jsx";
import { FlowEmptyState } from "./flows/flowComponents/FlowEmptyState.jsx";
import { ConfirmModal } from "./flows/flowComponents/ConfirmModal.jsx";
import { MoreMenu } from "./flows/flowComponents/MoreMenu.jsx";
import { getApiErrorMessage } from "./onboardingUtils.jsx";
import {
  NEW_FLOW_TEMPLATE,
  buildFlowFromForm,
  buildReleaseRadarFlowFromForm,
  buildEditorialFlowFromForm,
  buildSharedTracklistPayload,
  downloadFlowShareBundle,
  flowToForm,
  formatFlowLastRunShort,
  formatNextRun,
  formatNextRunShort,
  getNextFlowName,
  getUnavailableFlowSourceMessage,
  isFlowDirty,
  isScheduleOnlyFlowDirty,
  normalizeMixPercent,
  normalizeNameKey,
  normalizeSharedTrackEntry,
  reserveUniqueFlowName,
  slugifyFilePart,
} from "./flows/flowPageUtils";

const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: "None" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 72, label: "Every 3 days" },
];

const FLOW_MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

function useFlowMobileLayout() {
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(FLOW_MOBILE_LAYOUT_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }
    const mediaQuery = window.matchMedia(FLOW_MOBILE_LAYOUT_QUERY);
    const handleChange = (event) => setIsMobileLayout(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isMobileLayout;
}

const PlaylistImportModal = lazy(() =>
  import("./flows/import/PlaylistImportModal.jsx").then((m) => ({
    default: m.PlaylistImportModal,
  })),
);
const FlowFormFields = lazy(() =>
  import("./flows/flowComponents/flowFormComponents.jsx").then((m) => ({
    default: m.FlowFormFields,
  })),
);
const ReleaseRadarRecipeFields = lazy(() =>
  import("./flows/flowComponents/flowFormComponents.jsx").then((m) => ({
    default: m.ReleaseRadarRecipeFields,
  })),
);
const EditorialRecipeFields = lazy(() =>
  import("./flows/flowComponents/flowFormComponents.jsx").then((m) => ({
    default: m.EditorialRecipeFields,
  })),
);

const LIBRARY_SIDEBAR_COLLAPSED_KEY = "aurral.playlists.sidebarCollapsed";

function readLibrarySidebarCollapsed() {
  try {
    return globalThis.localStorage?.getItem(LIBRARY_SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function FlowPage({ mode = "all" }) {
  const fixedLibraryFilter = mode === "flows" ? "flows" : mode === "playlists" ? "playlists" : null;
  useDocumentTitle(mode === "flows" ? "Flows" : "Playlists");
  const navigate = useNavigate();
  const location = useLocation();
  const {
    status,
    loading,
    fetchStatus,
    getPlaylistStats,
    getPlaylistState,
    countdownNow,
    sharedPlaylists,
    flows: flowList,
  } = useFlowStatus();
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [libraryFilter, setLibraryFilter] = useState(fixedLibraryFilter || "all");
  const [libraryCollapsed, setLibraryCollapsed] = useState(readLibrarySidebarCollapsed);
  const [detailTab, setDetailTab] = useState("tracks");
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const isMobileLayout = useFlowMobileLayout();
  const [optimisticEnabled, setOptimisticEnabled] = useState({});
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [convertingId, setConvertingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [togglingToEnabled, setTogglingToEnabled] = useState(null);
  const [rerunningId, setRerunningId] = useState(null);
  const [renameModal, setRenameModal] = useState(null);
  const [artworkRevisionById, setArtworkRevisionById] = useState({});
  const [coverArtworkBusyId, setCoverArtworkBusyId] = useState(null);
  const [coverArtworkError, setCoverArtworkError] = useState("");
  const [simpleDrafts, setSimpleDrafts] = useState({});
  const [simpleErrors, setSimpleErrors] = useState({});
  const [sharedPlaylistErrors, setSharedPlaylistErrors] = useState({});
  const [applyingFlowId, setApplyingFlowId] = useState(null);
  const [applyingFlowNameId, setApplyingFlowNameId] = useState(null);
  const [applyingSharedPlaylistNameId, setApplyingSharedPlaylistNameId] = useState(null);
  const [reSearchingTrackIds, setReSearchingTrackIds] = useState({});
  const [reSearchingMissingPlaylistId, setReSearchingMissingPlaylistId] = useState(null);
  const [searchingUpgradePlaylistId, setSearchingUpgradePlaylistId] = useState(null);
  const [syncingImportPlaylistId, setSyncingImportPlaylistId] = useState(null);
  const [updatingSyncIntervalPlaylistId, setUpdatingSyncIntervalPlaylistId] = useState(null);
  const [savingToPlaylistId, setSavingToPlaylistId] = useState(null);
  const [deletingTrackId, setDeletingTrackId] = useState(null);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState([]);
  const [selectedTracksLoading, setSelectedTracksLoading] = useState(false);
  const [selectedTracksError, setSelectedTracksError] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [createPlaylistError, setCreatePlaylistError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const [playlistMenuError, setPlaylistMenuError] = useState("");
  const playlistsLoading = false;
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const disabledFlowSources = status?.capabilities?.unavailableSources || {};
  const canCreateGeneratedFlow = Object.keys(disabledFlowSources).length === 0;

  useEffect(() => {
    if (fixedLibraryFilter) setLibraryFilter(fixedLibraryFilter);
  }, [fixedLibraryFilter]);

  useEffect(() => {
    if (!selectedId || !status?.flows?.length) return;
    const flow = status.flows.find((entry) => entry.id === selectedId);
    if (!flow) return;
    setSimpleDrafts((prev) => {
      const existing = prev[flow.id];
      return {
        [flow.id]: existing ? { ...flowToForm(flow), ...existing } : flowToForm(flow),
      };
    });
  }, [selectedId, status?.flows]);

  const handleCancelSimple = (flow) => {
    setSimpleDrafts((prev) => ({
      ...prev,
      [flow.id]: flowToForm(flow),
    }));
    setSimpleErrors(({ [flow.id]: _, ...prev }) => prev);
    setDetailTab("tracks");
  };

  const handleApplySimple = async (flow) => {
    setApplyingFlowId(flow.id);
    setSimpleErrors(({ [flow.id]: _, ...prev }) => prev);
    try {
      const draft = simpleDrafts[flow.id] || flowToForm(flow);
      if (!isReleaseRadarFlow(flow) && !isEditorialFlow(flow)) {
        const sourceError = getUnavailableFlowSourceMessage(draft, disabledFlowSources);
        if (sourceError) {
          throw new Error(sourceError);
        }
      }
      const payload = isReleaseRadarFlow(flow)
        ? buildReleaseRadarFlowFromForm(flow, draft)
        : isEditorialFlow(flow)
        ? buildEditorialFlowFromForm(flow, draft)
        : buildFlowFromForm(draft);
      const response = await updateFlow(flow.id, payload);
      const updatedFlow = response?.flow || {
        ...flow,
        ...payload,
      };
      setSimpleDrafts((prev) => ({
        ...prev,
        [flow.id]: flowToForm(updatedFlow),
      }));
      setDetailTab("tracks");
      showSuccess("Flow updated");
      await fetchStatus();
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to update flow";
      setSimpleErrors((prev) => ({ ...prev, [flow.id]: message }));
      showError(message);
    } finally {
      setApplyingFlowId(null);
    }
  };

  const handleApplyFlowNameEdit = async (flow, nameOverride) => {
    if (!flow?.id) return;
    setApplyingFlowNameId(flow.id);
    setSimpleErrors(({ [flow.id]: _, ...prev }) => prev);
    try {
      const currentDraft = simpleDrafts[flow.id] ?? flowToForm(flow);
      if (!isReleaseRadarFlow(flow) && !isEditorialFlow(flow)) {
        const sourceError = getUnavailableFlowSourceMessage(currentDraft, disabledFlowSources);
        if (sourceError) {
          throw new Error(sourceError);
        }
      }
      const nextName =
        nameOverride !== undefined
          ? String(nameOverride).trim()
          : String(currentDraft?.name ?? flow.name ?? "").trim();
      const payload = isReleaseRadarFlow(flow)
        ? {
            ...buildReleaseRadarFlowFromForm(flow, currentDraft),
            name: nextName,
          }
        : isEditorialFlow(flow)
        ? {
            ...buildEditorialFlowFromForm(flow, currentDraft),
            name: nextName,
          }
        : buildFlowFromForm({
            ...flowToForm(flow),
            name: nextName,
          });
      const response = await updateFlow(flow.id, payload);
      const updatedFlow = response?.flow || {
        ...flow,
        ...payload,
      };
      setSimpleDrafts((prev) => ({
        ...prev,
        [flow.id]: {
          ...(prev[flow.id] ?? flowToForm(updatedFlow)),
          name: updatedFlow.name || "",
        },
      }));
      showSuccess("Flow updated");
      await fetchStatus();
      return true;
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to update flow";
      setSimpleErrors((prev) => ({ ...prev, [flow.id]: message }));
      showError(message);
      return false;
    } finally {
      setApplyingFlowNameId(null);
    }
  };

  const handleCreateInline = async () => {
    if (creating) return;
    if (!canCreateGeneratedFlow) {
      showError("Flows require a Last.fm API key in this version");
      return;
    }
    setCreating(true);
    try {
      const uniqueName = getNextFlowName(status?.flows, NEW_FLOW_TEMPLATE.name);
      const draft = flowToForm({
        ...NEW_FLOW_TEMPLATE,
        name: uniqueName,
      });
      const payload = buildFlowFromForm(draft);
      const response = await createFlow(payload);
      const createdFlow = response?.flow;
      if (createdFlow?.id) {
        setSimpleDrafts((prev) => ({
          ...prev,
          [createdFlow.id]: flowToForm(createdFlow),
        }));
        setSelectedId(createdFlow.id);
        setDetailTab("recipe");
        setMobileShowDetail(true);
      }
      showSuccess("Flow created");
      await fetchStatus();
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to create flow";
      showError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleOpenCreatePlaylist = () => {
    setCreatePlaylistError("");
    setIsCreatePlaylistOpen(true);
  };

  const handleCreatePlaylist = async (name) => {
    setCreatingPlaylist(true);
    setCreatePlaylistError("");
    try {
      await createSharedPlaylist({ name });
      showSuccess("Playlist created");
      setIsCreatePlaylistOpen(false);
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to create playlist";
      setCreatePlaylistError(message);
      showError(message);
    } finally {
      setCreatingPlaylist(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.flowId);
    try {
      if (confirmDelete.kind === "shared") {
        await deleteSharedPlaylist(confirmDelete.flowId);
        showSuccess("Shared playlist deleted");
      } else {
        await deleteFlow(confirmDelete.flowId);
        showSuccess("Flow deleted");
      }
      await fetchStatus();
      if (selectedId === confirmDelete.flowId) {
        setSelectedId(null);
        setMobileShowDetail(false);
      }
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.message ||
          (confirmDelete.kind === "shared"
            ? "Failed to delete shared playlist"
            : "Failed to delete flow"),
      );
    } finally {
      setDeletingId(null);
    }
    setConfirmDelete(null);
  };

  const fetchFlowTracks = useCallback(
    async (flowId, { showSpinner = true, signal } = {}) => {
      if (!flowId) return;
      if (showSpinner) {
        setSelectedTracksLoading(true);
      }
      setSelectedTracksError("");
      try {
        const jobs = await getFlowJobs(flowId, null, { signal });
        if (signal?.aborted) return;
        const normalized = (Array.isArray(jobs) ? jobs : []).map((job) => ({
          ...job,
          albumName: job?.albumName || null,
          reason: job?.reason || null,
          streamUrl: job?.status === "done" && job?.id ? getFlowTrackStreamUrl(job.id) : null,
        }));
        setSelectedTracks(normalized);
      } catch (err) {
        if (signal?.aborted) return;
        const message = err.response?.data?.message || err.message || "Failed to load tracks";
        setSelectedTracksError(message);
        showError(message);
      } finally {
        if (showSpinner && !signal?.aborted) {
          setSelectedTracksLoading(false);
        }
      }
    },
    [showError],
  );

  const handleToggleEnabled = async (flow, nextEnabled) => {
    setTogglingId(flow.id);
    setTogglingToEnabled(nextEnabled);
    try {
      await setFlowEnabled(flow.id, nextEnabled);
      showSuccess(nextEnabled ? "Flow enabled" : "Flow disabled");
      await fetchStatus();
    } catch (err) {
      showError(err.response?.data?.message || err.message || "Failed to update flow");
    } finally {
      setOptimisticEnabled(({ [flow.id]: _, ...prev }) => prev);
      setTogglingId(null);
      setTogglingToEnabled(null);
    }
  };

  const handleRunNow = async (flow) => {
    if (!flow?.id || flow.enabled !== true) return;
    setRerunningId(flow.id);
    try {
      const response = await startFlowPlaylist(flow.id, flow.size);
      const tracksQueued = Number(response?.tracksQueued || 0);
      showSuccess(
        tracksQueued > 0
          ? `${flow.name} queued ${tracksQueued} tracks`
          : `${flow.name} run started`,
      );
      await fetchStatus();
      if (selectedId === flow.id) {
        await fetchFlowTracks(flow.id, { showSpinner: false });
      }
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to run flow",
      );
    } finally {
      setRerunningId(null);
    }
  };

  const handleToggleRequest = (flow, nextEnabled) => {
    if (!nextEnabled) {
      setConfirmDisable({ flowId: flow.id, title: flow.name });
      return;
    }
    setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: true }));
    handleToggleEnabled(flow, true);
  };

  const getNextPlaylistName = useCallback(
    (baseName = "Playlist") => {
      const reservedNames = new Set(
        sharedPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean),
      );
      return reserveUniqueFlowName(reservedNames, baseName);
    },
    [sharedPlaylists],
  );
  const effectiveFlowList = useMemo(
    () =>
      flowList.map((flow) => {
        const optimisticValue = optimisticEnabled[flow.id];
        if (typeof optimisticValue !== "boolean") return flow;
        return {
          ...flow,
          enabled: optimisticValue,
        };
      }),
    [flowList, optimisticEnabled],
  );

  const collection = useMemo(() => {
    const shared = sharedPlaylists.map((playlist) => ({
      ...playlist,
      kind: "shared",
    }));
    const generated = effectiveFlowList.map((flow) => ({
      ...flow,
      kind: "flow",
    }));
    return [...shared, ...generated];
  }, [sharedPlaylists, effectiveFlowList]);

  const activeLibraryFilter = fixedLibraryFilter || libraryFilter;
  const filteredCollection = useMemo(() => {
    if (activeLibraryFilter === "playlists") {
      return collection.filter((entry) => entry.kind === "shared");
    }
    if (activeLibraryFilter === "flows") {
      return collection.filter((entry) => entry.kind === "flow");
    }
    return collection;
  }, [activeLibraryFilter, collection]);

  const selectedEntry = useMemo(
    () => collection.find((entry) => entry.id === selectedId) || null,
    [collection, selectedId],
  );

  useEffect(() => {
    const navPlaylistId = location.state?.selectedPlaylistId;
    if (navPlaylistId) {
      const navEntry = collection.find((entry) => entry.id === navPlaylistId);
      if (navEntry && !filteredCollection.some((entry) => entry.id === navPlaylistId)) {
        setLibraryFilter("all");
        return;
      }
    }
    if (!filteredCollection.length) {
      if (!navPlaylistId && selectedId) {
        setSelectedId(null);
        setMobileShowDetail(false);
      }
      return;
    }
    if (
      isMobileLayout &&
      selectedId &&
      !filteredCollection.some((entry) => entry.id === selectedId)
    ) {
      setSelectedId(null);
      setMobileShowDetail(false);
      return;
    }
    if (navPlaylistId && filteredCollection.some((entry) => entry.id === navPlaylistId)) {
      setSelectedId(navPlaylistId);
      setMobileShowDetail(true);
      setDetailTab("tracks");
      navigate(location.pathname, { replace: true, state: {} });
      return;
    }
    if (
      !isMobileLayout &&
      (!selectedId || !filteredCollection.some((entry) => entry.id === selectedId))
    ) {
      setSelectedId(filteredCollection[0].id);
    }
  }, [
    collection,
    filteredCollection,
    isMobileLayout,
    location.pathname,
    location.state?.selectedPlaylistId,
    navigate,
    selectedId,
  ]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedTracks([]);
      setSelectedTracksLoading(false);
      setSelectedTracksError("");
      return;
    }
    setSelectedTracks([]);
    setSelectedTracksError("");
    const controller = new AbortController();
    fetchFlowTracks(selectedId, { signal: controller.signal });
    return () => controller.abort();
  }, [selectedId, fetchFlowTracks]);

  const selectPlaylist = (entry) => {
    if (isMobileLayout && selectedId === entry.id && mobileShowDetail) {
      setMobileShowDetail(false);
      return;
    }
    setSelectedId(entry.id);
    if (isMobileLayout) {
      setMobileShowDetail(true);
    }
    setDetailTab("tracks");
    setRenameModal(null);
  };

  const handleConfirmDisable = async () => {
    if (!confirmDisable) return;
    const flow = flowList.find((entry) => entry.id === confirmDisable.flowId);
    if (flow) {
      setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: false }));
      await handleToggleEnabled(flow, false);
    }
    setConfirmDisable(null);
  };

  const exportTracklist = async ({
    playlistId,
    playlistName,
    sourceName = null,
    sourceFlowId = null,
  }) => {
    if (!playlistId) return;
    const jobs =
      playlistId === selectedId && selectedTracks.length > 0
        ? selectedTracks
        : await getFlowJobs(playlistId);
    const tracks = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job?.status !== "failed")
      .map((job) => ({
        artistName: job.artistName,
        trackName: job.trackName,
        albumName: job.albumName || null,
        artistMbid: job.artistMbid || null,
        albumMbid: job.albumMbid || null,
        trackMbid: job.trackMbid || null,
        releaseYear: job.releaseYear || null,
        durationMs: job.durationMs || null,
        artistAliases: job.artistAliases || [],
      }))
      .filter((track) => track.artistName && track.trackName);
    if (tracks.length === 0) {
      throw new Error("No generated tracks available to export yet");
    }
    downloadFlowShareBundle(
      `aurral-tracklist-${slugifyFilePart(playlistName)}.json`,
      buildSharedTracklistPayload({
        name: playlistName,
        sourceName: sourceName || playlistName,
        sourceFlowId,
        tracks,
      }),
    );
  };

  const handleExportFlow = async (flow) => {
    if (!flow) return;
    try {
      await exportTracklist({
        playlistId: flow.id,
        playlistName: flow.name,
        sourceName: flow.name,
        sourceFlowId: flow.id,
      });
      showSuccess(`Exported ${flow.name} tracklist`);
    } catch (error) {
      showError(error?.message || "Failed to export tracklist");
    }
  };

  const handleCopyLidarrImportListUrl = async (flow) => {
    if (!flow) return;
    try {
      const response = await getFlowLidarrImportListUrl(flow.id);
      const token = String(response?.token || "").trim();
      if (!token) {
        throw new Error("Feed URL unavailable");
      }
      const url = new URL(
        `/api/feeds/lidarr/flows/${encodeURIComponent(flow.id)}.json`,
        window.location.origin,
      );
      url.searchParams.set("token", token);
      await navigator.clipboard.writeText(url.toString());
      showSuccess("Copied Lidarr import URL");
    } catch (error) {
      showError(error?.message || "Failed to copy Lidarr import URL");
    }
  };

  const handleDeleteSharedPlaylist = (playlist) => {
    if (!playlist) return;
    setConfirmDelete({
      flowId: playlist.id,
      title: playlist.name,
      kind: "shared",
    });
  };

  const handleApplySharedPlaylist = async (playlist, nameOverride) => {
    if (!playlist) return;
    setApplyingSharedPlaylistNameId(playlist.id);
    setSharedPlaylistErrors(({ [playlist.id]: _, ...prev }) => prev);
    try {
      const name = String(nameOverride ?? playlist.name ?? "").trim();
      await updateSharedPlaylist(playlist.id, { name });
      showSuccess("Static playlist updated");
      await fetchStatus();
      return true;
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to update static playlist";
      setSharedPlaylistErrors((prev) => ({
        ...prev,
        [playlist.id]: message,
      }));
      showError(message);
      return false;
    } finally {
      setApplyingSharedPlaylistNameId(null);
    }
  };

  const handleConvertFlowToStatic = async (flow) => {
    if (!flow || convertingId) return;
    setConvertingId(flow.id);
    try {
      const reservedNames = new Set(
        (status?.sharedPlaylists || [])
          .map((playlist) => normalizeNameKey(playlist?.name))
          .filter(Boolean),
      );
      const playlistName = reserveUniqueFlowName(reservedNames, `${flow.name} Static`);
      const response = await convertFlowToStaticPlaylist(flow.id, {
        name: playlistName,
      });
      showSuccess(
        `Saved ${flow.name} as static playlist${response?.playlist?.name ? `: ${response.playlist.name}` : ""}`,
      );
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to create static playlist",
      );
    } finally {
      setConvertingId(null);
    }
  };

  const loadPlaylistsForMenu = useCallback(async () => {
    setPlaylistMenuError("");
  }, []);

  const getDefaultTrackPlaylistName = (track) =>
    getNextPlaylistName(`${track?.artistName || "Artist"} Picks`);

  const saveTrackToPlaylist = async (track, target, { moveFromPlaylistId = null } = {}) => {
    const payload = normalizeSharedTrackEntry(track);
    if (!payload) {
      showError("Track details are incomplete");
      return;
    }
    setPlaylistMenuError("");
    setPlaylistMenuSavingKey(String(track?.id ?? ""));
    const targetPlaylistId =
      target?.mode === "new" ? null : String(target?.playlistId || "").trim() || null;
    if (targetPlaylistId) {
      setSavingToPlaylistId(targetPlaylistId);
    }
    const sourceTrackJobId = track?.id || null;
    try {
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() || getNextPlaylistName(`${payload.artistName} Picks`);
        const response = await createSharedPlaylist({
          name,
          tracks: [payload],
        });
        if (moveFromPlaylistId && sourceTrackJobId) {
          await deleteSharedPlaylistTrack(moveFromPlaylistId, sourceTrackJobId);
          showSuccess(`Track moved to ${response?.playlist?.name || name}`);
        } else {
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        }
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (playlist) => playlist.id === target?.playlistId,
        );
        await addSharedPlaylistTracks(target.playlistId, {
          tracks: [payload],
        });
        if (moveFromPlaylistId && sourceTrackJobId) {
          await deleteSharedPlaylistTrack(moveFromPlaylistId, sourceTrackJobId);
          showSuccess(`Track moved to ${targetPlaylist?.name || "playlist"}`);
        } else {
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
      }
      await fetchStatus();
      if (selectedId) {
        await fetchFlowTracks(selectedId, { showSpinner: false });
      }
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to save track to playlist";
      setPlaylistMenuError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
      setSavingToPlaylistId(null);
    }
  };

  const handleMoveTrackToPlaylist = (track, target, moveFromPlaylistId) =>
    saveTrackToPlaylist(track, target, { moveFromPlaylistId });

  const bumpArtworkRevision = useCallback((playlistId) => {
    if (!playlistId) return;
    setArtworkRevisionById((prev) => ({
      ...prev,
      [playlistId]: (prev[playlistId] || 0) + 1,
    }));
  }, []);

  const artworkUrlFor = useCallback(
    (playlistId) => getFlowArtworkUrl(playlistId, artworkRevisionById[playlistId]),
    [artworkRevisionById],
  );

  const handleOpenEditModal = (entry) => {
    const target = entry || selectedEntry;
    if (!target) return;
    if (target.id !== selectedId) {
      selectPlaylist(target);
    }
    setCoverArtworkError("");
    if (target.kind === "flow") {
      setSimpleErrors(({ [target.id]: _, ...prev }) => prev);
      setRenameModal({
        kind: "flow",
        id: target.id,
        name: target.name || "",
      });
      return;
    }
    setSharedPlaylistErrors(({ [target.id]: _, ...prev }) => prev);
    setRenameModal({
      kind: "shared",
      id: target.id,
      name: target.name || "",
    });
  };

  const handleUploadCover = async (file) => {
    const playlistId = renameModal?.id;
    if (!playlistId || !file) return;
    setCoverArtworkBusyId(playlistId);
    setCoverArtworkError("");
    try {
      await uploadFlowArtwork(playlistId, file);
      bumpArtworkRevision(playlistId);
      showSuccess("Cover updated");
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to upload cover";
      setCoverArtworkError(message);
      showError(message);
    } finally {
      setCoverArtworkBusyId(null);
    }
  };

  const handleRemoveCover = async () => {
    const playlistId = renameModal?.id;
    if (!playlistId) return;
    setCoverArtworkBusyId(playlistId);
    setCoverArtworkError("");
    try {
      await deleteFlowArtwork(playlistId);
      bumpArtworkRevision(playlistId);
      showSuccess("Cover removed");
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to remove cover";
      setCoverArtworkError(message);
      showError(message);
    } finally {
      setCoverArtworkBusyId(null);
    }
  };

  const handleGenerateCover = async () => {
    const playlistId = renameModal?.id;
    if (!playlistId) return;
    setCoverArtworkBusyId(playlistId);
    setCoverArtworkError("");
    try {
      await generateFlowArtwork(playlistId);
      bumpArtworkRevision(playlistId);
      showSuccess("Cover generated");
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to generate cover";
      setCoverArtworkError(message);
      showError(message);
    } finally {
      setCoverArtworkBusyId(null);
    }
  };

  const handleRenameModalSubmit = async (nextName) => {
    if (!renameModal) return;
    if (renameModal.kind === "flow") {
      const flow = effectiveFlowList.find((entry) => entry.id === renameModal.id);
      if (!flow) return;
      const saved = await handleApplyFlowNameEdit(flow, nextName);
      if (saved) setRenameModal(null);
      return;
    }
    const playlist = sharedPlaylists.find((entry) => entry.id === renameModal.id);
    if (!playlist) return;
    const saved = await handleApplySharedPlaylist(playlist, nextName);
    if (saved) setRenameModal(null);
  };

  const handleDeleteSharedPlaylistTrack = async (playlistId, track) => {
    const jobId = track?.id;
    if (!playlistId || !jobId || deletingTrackId === jobId) return;
    setDeletingTrackId(jobId);
    try {
      await deleteSharedPlaylistTrack(playlistId, jobId);
      showSuccess(`Removed ${track.trackName || "track"}`);
      await fetchStatus();
      await fetchFlowTracks(playlistId, { showSpinner: false });
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to remove track",
      );
    } finally {
      setDeletingTrackId(null);
    }
  };

  const handleReSearchTrack = async (playlistId, track, isFlow = false) => {
    const jobId = track?.id;
    if (!playlistId || !jobId || reSearchingTrackIds[jobId]) return;
    setReSearchingTrackIds((prev) => ({
      ...prev,
      [jobId]: true,
    }));
    if (track.status !== "done" && playlistId === selectedId) {
      setSelectedTracks((prev) =>
        prev.map((entry) =>
          entry?.id === jobId
            ? {
                ...entry,
                status: "pending",
                error: null,
                streamUrl: null,
              }
            : entry,
        ),
      );
    }
    try {
      if (track.status === "done") {
        const result = await searchTrackUpgrade(playlistId, jobId);
        showSuccess(
          result?.alreadyQueued
            ? `Upgrade search already queued for ${track.trackName}`
            : `Searching for an upgrade to ${track.trackName}`,
        );
      } else if (isFlow) {
        await reSearchFlowTrack(playlistId, jobId);
        showSuccess(`Re-searching ${track.trackName}`);
      } else {
        await reSearchSharedPlaylistTrack(playlistId, jobId);
        showSuccess(`Re-searching ${track.trackName}`);
      }
      await fetchStatus();
      await fetchFlowTracks(playlistId, { showSpinner: false });
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to re-search track";
      showError(message);
      await fetchFlowTracks(playlistId, { showSpinner: false });
    } finally {
      setReSearchingTrackIds(({ [jobId]: _, ...prev }) => prev);
    }
  };

  const handleSearchPlaylistUpgrades = async (playlistId) => {
    if (!playlistId || searchingUpgradePlaylistId) return;
    setSearchingUpgradePlaylistId(playlistId);
    try {
      const result = await searchPlaylistUpgrades(playlistId);
      showSuccess(
        result?.scheduled
          ? "Upgrade search queued"
          : result?.queued > 0
          ? `Searching upgrades for ${result.queued} track${result.queued !== 1 ? "s" : ""}`
          : "No tracks are eligible for an upgrade",
      );
      await fetchFlowTracks(playlistId, { showSpinner: false });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to search for upgrades"));
    } finally {
      setSearchingUpgradePlaylistId(null);
    }
  };

  const handleReSearchMissingSharedPlaylistTracks = async (playlistId) => {
    if (!playlistId || reSearchingMissingPlaylistId) return;
    setReSearchingMissingPlaylistId(playlistId);
    try {
      const result = await reSearchMissingSharedPlaylistTracks(playlistId);
      showSuccess(
        result?.requeued > 0
          ? `Re-searching ${result.requeued} track${result.requeued !== 1 ? "s" : ""}`
          : "No failed tracks to re-search",
      );
      await fetchStatus();
      await fetchFlowTracks(playlistId, { showSpinner: false });
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to re-search missing tracks";
      showError(message);
    } finally {
      setReSearchingMissingPlaylistId(null);
    }
  };

  const handleSyncSpotifyPlaylist = async (playlist) => {
    if (!playlist?.id || syncingImportPlaylistId) return;
    setSyncingImportPlaylistId(playlist.id);
    try {
      const result = await syncSharedPlaylistImport(playlist.id);
      if (result?.skipped) {
        showSuccess("Playlist is already up to date");
      } else {
        const queued = Number(result?.tracksQueued || 0);
        showSuccess(
          queued > 0
            ? `Synced ${queued} new track${queued !== 1 ? "s" : ""} from Spotify`
            : "Spotify playlist synced",
        );
      }
      await fetchStatus();
      await fetchFlowTracks(playlist.id, { showSpinner: false });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to sync playlist"));
    } finally {
      setSyncingImportPlaylistId(null);
    }
  };

  const handleUpdateSpotifySyncInterval = async (playlist, syncIntervalHours) => {
    if (!playlist?.id || updatingSyncIntervalPlaylistId) return;
    const current = playlist.importSource?.syncIntervalHours ?? 0;
    if (syncIntervalHours === current) return;
    setUpdatingSyncIntervalPlaylistId(playlist.id);
    try {
      await updateSharedPlaylist(playlist.id, {
        importSource: {
          syncIntervalHours,
          syncEnabled: syncIntervalHours > 0,
        },
      });
      showSuccess(syncIntervalHours > 0 ? "Sync schedule updated" : "Auto-sync turned off");
      await fetchStatus();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to update sync schedule"));
    } finally {
      setUpdatingSyncIntervalPlaylistId(null);
    }
  };

  const handleNavigateArtist = (track) => {
    if (!track?.artistMbid) return;
    navigate(`/artist/${track.artistMbid}`, {
      state: { artistName: track.artistName },
    });
  };

  const handleBulkDelete = async (tracks) => {
    if (!selectedPlaylist) return;
    setBulkActionLoading(true);
    let removed = 0;
    const failed = [];
    for (const track of tracks) {
      if (!track?.id) continue;
      try {
        await deleteSharedPlaylistTrack(selectedPlaylist.id, track.id);
        removed++;
      } catch {
        failed.push(track.trackName || "unknown");
      }
    }
    if (removed > 0) {
      showSuccess(`Removed ${removed} track${removed !== 1 ? "s" : ""}`);
    }
    if (failed.length > 0) {
      showError(`Failed to remove: ${failed.join(", ")}`);
    }
    setBulkActionLoading(false);
    await fetchStatus();
    await fetchFlowTracks(selectedPlaylist.id, { showSpinner: false });
  };

  const handleBulkReSearch = async (tracks) => {
    if (!selectedPlaylist) return;
    setBulkActionLoading(true);
    let requeued = 0;
    for (const track of tracks) {
      if (!track?.id) continue;
      const canReSearch = track.status === "done" || track.status === "failed";
      if (!canReSearch || reSearchingTrackIds[track.id]) continue;
      setReSearchingTrackIds((prev) => ({ ...prev, [track.id]: true }));
      setSelectedTracks((prev) =>
        prev.map((entry) =>
          entry?.id === track.id
            ? { ...entry, status: "pending", error: null, streamUrl: null }
            : entry,
        ),
      );
      try {
        if (track.status === "done") {
          await searchTrackUpgrade(selectedPlaylist.id, track.id);
        } else {
          await reSearchSharedPlaylistTrack(selectedPlaylist.id, track.id);
        }
        requeued++;
      } catch {
      }
    }
    if (requeued > 0) {
      showSuccess(`Re-searching ${requeued} track${requeued !== 1 ? "s" : ""}`);
    }
    setBulkActionLoading(false);
    await fetchStatus();
    await fetchFlowTracks(selectedPlaylist.id, { showSpinner: false });
  };

  const handleBulkAddToPlaylist = async (tracks, target) => {
    const payloads = tracks
      .map((t) => normalizeSharedTrackEntry(t))
      .filter(Boolean);
    if (payloads.length === 0) {
      showError("No valid tracks to add");
      return;
    }
    setBulkActionLoading(true);
    try {
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() || getNextPlaylistName("Playlist");
        const response = await createSharedPlaylist({ name, tracks: payloads });
        showSuccess(
          `Added ${payloads.length} track${payloads.length !== 1 ? "s" : ""} to ${response?.playlist?.name || name}`,
        );
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (p) => p.id === target?.playlistId,
        );
        await addSharedPlaylistTracks(target.playlistId, { tracks: payloads });
        showSuccess(
          `Added ${payloads.length} track${payloads.length !== 1 ? "s" : ""} to ${targetPlaylist?.name || "playlist"}`,
        );
      }
      await fetchStatus();
      if (selectedId) {
        await fetchFlowTracks(selectedId, { showSpinner: false });
      }
    } catch (err) {
      showError(
        err.response?.data?.message || err.message || "Failed to add tracks",
      );
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkMoveToPlaylist = async (tracks, target) => {
    if (!selectedPlaylist) return;
    const payloads = tracks
      .map((t) => normalizeSharedTrackEntry(t))
      .filter(Boolean);
    if (payloads.length === 0) {
      showError("No valid tracks to move");
      return;
    }
    setBulkActionLoading(true);
    try {
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() || getNextPlaylistName("Playlist");
        await createSharedPlaylist({ name, tracks: payloads });
        for (const track of tracks) {
          if (track?.id) {
            await deleteSharedPlaylistTrack(selectedPlaylist.id, track.id);
          }
        }
        showSuccess(
          `Moved ${payloads.length} track${payloads.length !== 1 ? "s" : ""} to ${name}`,
        );
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (p) => p.id === target?.playlistId,
        );
        await addSharedPlaylistTracks(target.playlistId, { tracks: payloads });
        for (const track of tracks) {
          if (track?.id) {
            await deleteSharedPlaylistTrack(selectedPlaylist.id, track.id);
          }
        }
        showSuccess(
          `Moved ${payloads.length} track${payloads.length !== 1 ? "s" : ""} to ${targetPlaylist?.name || "playlist"}`,
        );
      }
      await fetchStatus();
      await fetchFlowTracks(selectedPlaylist.id, { showSpinner: false });
    } catch (err) {
      showError(
        err.response?.data?.message || err.message || "Failed to move tracks",
      );
    } finally {
      setBulkActionLoading(false);
    }
  };
  if (loading && !status) {
    return (
      <div className="flow-page__loading">
        <Loader2 className="artist-spinner artist-spinner--large" />
      </div>
    );
  }

  const selectedIsFlow = selectedEntry?.kind === "flow";
  const selectedFlow =
    selectedIsFlow && selectedEntry
      ? effectiveFlowList.find((flow) => flow.id === selectedEntry.id)
      : null;
  const selectedPlaylist =
    selectedEntry?.kind === "shared"
      ? sharedPlaylists.find((playlist) => playlist.id === selectedEntry.id)
      : null;
  const selectedStats = selectedId ? getPlaylistStats(selectedId) : null;
  const playbackSource = selectedEntry
    ? {
        type: selectedIsFlow ? "flow" : "playlist",
        id: selectedEntry.id,
        label: selectedFlow?.name || selectedPlaylist?.name || selectedEntry.name || "Playlist",
      }
    : null;
  const flowEnabled = selectedFlow?.enabled === true;
  const flowNextRun =
    selectedFlow && flowEnabled ? formatNextRun(selectedFlow.nextRunAt, countdownNow) : null;
  const flowLastRun = selectedFlow ? formatFlowLastRun(selectedFlow.lastRunAt) : null;
  const selectedEntryUsername = selectedEntry?.ownerUsername || user?.username || null;
  const selectedEntryTotalTracks = (() => {
    if (!selectedEntry) return 0;
    if (selectedEntry.kind === "flow") {
      return getFlowDisplayTrackCount(selectedFlow, selectedStats, selectedTracks.length);
    }
    return getSharedPlaylistTrackCount(selectedPlaylist, selectedStats, selectedTracks.length);
  })();
  const selectedEntryTrackLabel = formatTrackCountLabel(selectedEntryTotalTracks, selectedStats);
  const flowLastRunShort = selectedFlow ? formatFlowLastRunShort(selectedFlow.lastRunAt) : null;
  const flowNextRunShort =
    selectedFlow && flowEnabled && getPlaylistState(selectedFlow.id) !== "running"
      ? formatNextRunShort(selectedFlow.nextRunAt, countdownNow)
      : null;
  const detailMetaLine =
    selectedEntry && !selectedIsFlow
      ? selectedEntryUsername
        ? `${selectedEntryUsername} · ${selectedEntryTrackLabel}`
        : selectedEntryTrackLabel
      : "";
  const detailFlowMeta =
    selectedIsFlow && selectedEntry
      ? {
          username: selectedEntryUsername,
          trackLabel: selectedEntryTrackLabel,
          lastRunShort: flowLastRunShort,
          lastRunTitle: flowLastRun ? `Last updated ${flowLastRun}` : "",
          nextRunShort: flowNextRunShort,
          nextRunTitle:
            flowNextRunShort === "soon"
              ? "Next update soon"
              : flowNextRun
                ? `Next update in ${flowNextRun}`
                : "",
        }
      : null;
  const simpleDraft =
    selectedFlow && simpleDrafts[selectedFlow.id]
      ? simpleDrafts[selectedFlow.id]
      : selectedFlow
        ? flowToForm(selectedFlow)
        : null;
  const simpleError = selectedFlow ? simpleErrors[selectedFlow.id] : null;
  const flowHasChanges =
    selectedFlow && simpleDraft
      ? isReleaseRadarFlow(selectedFlow) || isEditorialFlow(selectedFlow)
        ? isScheduleOnlyFlowDirty(selectedFlow, simpleDraft)
        : isFlowDirty(selectedFlow, simpleDraft)
      : false;
  const flowCanExport = Number(selectedStats?.total || 0) > 0;
  const flowCanConvert = Number(selectedStats?.done || 0) > 0;
  const countReSearchingForPlaylist = (playlistId) => {
    if (!playlistId || playlistId !== selectedId) return 0;
    if (!Array.isArray(selectedTracks) || selectedTracks.length === 0) return 0;
    let count = 0;
    for (const track of selectedTracks) {
      if (track?.id && reSearchingTrackIds[track.id]) count += 1;
    }
    return count;
  };
  const getEntryActivityMessage = (entry) => {
    if (!entry?.id) return null;
    const isFlow = entry.kind === "flow";
    const activity = getPlaylistRunActivity({
      playlistId: entry.id,
      kind: isFlow ? "flow" : "playlist",
      enabled: isFlow ? entry.enabled === true : true,
      status,
      stats: getPlaylistStats(entry.id),
      rerunning: rerunningId === entry.id,
      togglingToEnabled: togglingId === entry.id ? togglingToEnabled : null,
      addingTrack: savingToPlaylistId === entry.id,
      reSearchingCount: countReSearchingForPlaylist(entry.id),
    });
    return activity?.message || null;
  };
  const selectedActivityMessage = selectedEntry ? getEntryActivityMessage(selectedEntry) : null;
  const flowCanRunNow =
    selectedFlow?.enabled === true && rerunningId !== selectedFlow?.id && !selectedActivityMessage;
  const renameModalSaving =
    renameModal?.kind === "flow"
      ? applyingFlowNameId === renameModal.id
      : renameModal?.kind === "shared"
        ? applyingSharedPlaylistNameId === renameModal.id
        : false;
  const renameModalError =
    renameModal?.kind === "flow"
      ? simpleErrors[renameModal.id] || ""
      : renameModal?.kind === "shared"
        ? sharedPlaylistErrors[renameModal.id] || ""
        : "";

  const selectedDetailMoreMenu = (
    <MoreMenu activeButtonClass="btn-neutral-active">
      {selectedIsFlow && selectedFlow ? (
        <>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleSearchPlaylistUpgrades(selectedFlow.id)}
            disabled={searchingUpgradePlaylistId === selectedFlow.id}
          >
            <span className="artist-menu-item__main">
              {searchingUpgradePlaylistId === selectedFlow.id ? (
                <Loader2 className="artist-icon-sm animate-spin" />
              ) : (
                <Search className="artist-icon-sm" />
              )}
              Search for upgrades
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleRunNow(selectedFlow)}
            disabled={!flowCanRunNow}
          >
            <span className="artist-menu-item__main">
              {rerunningId === selectedFlow.id ? (
                <Loader2 className="artist-icon-sm animate-spin" />
              ) : (
                <Play className="artist-icon-sm" />
              )}
              Run now
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleConvertFlowToStatic(selectedFlow)}
            disabled={!flowCanConvert || convertingId === selectedFlow.id}
          >
            <span className="artist-menu-item__main">
              <FilePlus2 className="artist-icon-sm" />
              Convert to static
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleCopyLidarrImportListUrl(selectedFlow)}
          >
            <span className="artist-menu-item__main">
              <ClipboardCopy className="artist-icon-sm" />
              Lidarr import URL
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleExportFlow(selectedFlow)}
            disabled={!flowCanExport}
          >
            <span className="artist-menu-item__main">
              <Download className="artist-icon-sm" />
              Export JSON
            </span>
          </button>
          <div className="flow-page__menu-divider" />
          <button
            type="button"
            className="artist-menu-item artist-menu-item--danger"
            onClick={() =>
              setConfirmDelete({
                flowId: selectedFlow.id,
                title: selectedFlow.name,
                kind: "flow",
              })
            }
            disabled={deletingId === selectedFlow.id}
          >
            <span className="artist-menu-item__main">
              <Trash2 className="artist-icon-sm" />
              Delete flow
            </span>
          </button>
        </>
      ) : selectedPlaylist ? (
        <>
          {selectedPlaylist?.importSource?.provider === "spotify-playlist" ? (
            <>
              <button
                type="button"
                className="artist-menu-item"
                onClick={() => handleSyncSpotifyPlaylist(selectedPlaylist)}
                disabled={syncingImportPlaylistId === selectedPlaylist.id}
              >
                <span className="artist-menu-item__main">
                  {syncingImportPlaylistId === selectedPlaylist.id ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <RefreshCw className="artist-icon-sm" />
                  )}
                  Sync now
                </span>
              </button>
              <div
                className="flow-page__menu-sync-row"
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <label
                  className="flow-page__menu-sync-label"
                  htmlFor={`playlist-sync-interval-${selectedPlaylist.id}`}
                >
                  Auto-sync
                </label>
                <select
                  id={`playlist-sync-interval-${selectedPlaylist.id}`}
                  className="flow-page__menu-sync-select"
                  value={selectedPlaylist.importSource?.syncIntervalHours ?? 0}
                  onChange={(event) =>
                    handleUpdateSpotifySyncInterval(
                      selectedPlaylist,
                      Number(event.target.value),
                    )
                  }
                  disabled={updatingSyncIntervalPlaylistId === selectedPlaylist.id}
                >
                  {SYNC_INTERVAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flow-page__menu-divider" />
            </>
          ) : null}
          <button
            type="button"
            className="artist-menu-item"
            onClick={() =>
              handleReSearchMissingSharedPlaylistTracks(selectedPlaylist.id)
            }
            disabled={reSearchingMissingPlaylistId === selectedPlaylist.id}
          >
            <span className="artist-menu-item__main">
              {reSearchingMissingPlaylistId === selectedPlaylist.id ? (
                <Loader2 className="artist-icon-sm animate-spin" />
              ) : (
                <Search className="artist-icon-sm" />
              )}
              Re-search missing
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleSearchPlaylistUpgrades(selectedPlaylist.id)}
            disabled={searchingUpgradePlaylistId === selectedPlaylist.id}
          >
            <span className="artist-menu-item__main">
              {searchingUpgradePlaylistId === selectedPlaylist.id ? (
                <Loader2 className="artist-icon-sm animate-spin" />
              ) : (
                <Search className="artist-icon-sm" />
              )}
              Search for upgrades
            </span>
          </button>
          <button
            type="button"
            className="artist-menu-item"
            onClick={() => handleExportFlow(selectedPlaylist)}
          >
            <span className="artist-menu-item__main">
              <Download className="artist-icon-sm" />
              Export JSON
            </span>
          </button>
          <div className="flow-page__menu-divider" />
          <button
            type="button"
            className="artist-menu-item artist-menu-item--danger"
            onClick={() => handleDeleteSharedPlaylist(selectedPlaylist)}
            disabled={deletingId === selectedPlaylist.id}
          >
            <span className="artist-menu-item__main">
              <Trash2 className="artist-icon-sm" />
              Delete playlist
            </span>
          </button>
        </>
      ) : null}
    </MoreMenu>
  );

  const selectedDetailBody = selectedEntry ? (
    <>
      {selectedIsFlow ? <FlowDetailTabs activeTab={detailTab} onChange={setDetailTab} /> : null}
      <div className="flow-page__detail-panel">
        {(!selectedIsFlow || detailTab === "tracks") && (selectedIsFlow || selectedPlaylist) ? (
          <FlowTracksPanel
            tracks={selectedTracks}
            loading={selectedTracksLoading}
            error={selectedTracksError}
            playbackSource={playbackSource}
            activityHint={selectedActivityMessage}
            emptyMessage={
              selectedIsFlow
                ? flowEnabled
                  ? "No tracks generated for this flow yet."
                  : "Enable this flow to generate tracks."
                : "No tracks in this playlist yet."
            }
            useTrackContextMenu={!selectedIsFlow}
            allowBulkEdit={!selectedIsFlow}
            bulkActionLoading={bulkActionLoading}
            onBulkDelete={selectedIsFlow ? undefined : handleBulkDelete}
            onBulkReSearch={selectedIsFlow ? undefined : handleBulkReSearch}
            onBulkAddToPlaylist={selectedIsFlow ? undefined : handleBulkAddToPlaylist}
            onBulkMoveToPlaylist={selectedIsFlow ? undefined : handleBulkMoveToPlaylist}
            playlists={sharedPlaylists}
            playlistsLoading={playlistsLoading}
            playlistSavingKey={playlistMenuSavingKey}
            playlistMenuError={playlistMenuError}
            excludedPlaylistIds={selectedPlaylist ? [selectedPlaylist.id] : []}
            getDefaultPlaylistName={getDefaultTrackPlaylistName}
            onLoadPlaylists={loadPlaylistsForMenu}
            reSearchingTrackIds={reSearchingTrackIds}
            deletingTrackId={selectedIsFlow ? undefined : deletingTrackId}
            onReSearchTrack={
              selectedIsFlow
                ? (track) => handleReSearchTrack(selectedFlow.id, track, true)
                : selectedPlaylist
                  ? (track) => handleReSearchTrack(selectedPlaylist.id, track)
                  : undefined
            }
            onDeleteTrack={
              selectedIsFlow || !selectedPlaylist
                ? undefined
                : (track) => handleDeleteSharedPlaylistTrack(selectedPlaylist.id, track)
            }
            onAddTrackToPlaylist={saveTrackToPlaylist}
            onMoveTrackToPlaylist={
              selectedIsFlow || !selectedPlaylist
                ? undefined
                : (track, target) => handleMoveTrackToPlaylist(track, target, selectedPlaylist.id)
            }
            onNavigateArtist={handleNavigateArtist}
          />
        ) : null}
        {detailTab === "recipe" && selectedIsFlow && simpleDraft ? (
          <div className="flow-page__form flow-page__detail-recipe">
            <Suspense fallback={null}>
              {isReleaseRadarFlow(selectedFlow) ? (
                <ReleaseRadarRecipeFields
                  draft={simpleDraft}
                  inputClassName="flow-page__field-control"
                  errorMessage={simpleError}
                  onDraftChange={(updater) =>
                    setSimpleDrafts((prev) => {
                      const base = prev[selectedFlow.id] ?? flowToForm(selectedFlow);
                      return {
                        ...prev,
                        [selectedFlow.id]: updater(base),
                      };
                    })
                  }
                  onClearError={() => {
                    if (simpleErrors[selectedFlow.id]) {
                      setSimpleErrors(({ [selectedFlow.id]: _, ...prev }) => prev);
                    }
                  }}
                />
              ) : isEditorialFlow(selectedFlow) ? (
                <EditorialRecipeFields
                  draft={simpleDraft}
                  inputClassName="flow-page__field-control"
                  errorMessage={simpleError}
                  tag={selectedFlow?.tag || ""}
                  onDraftChange={(updater) =>
                    setSimpleDrafts((prev) => {
                      const base = prev[selectedFlow.id] ?? flowToForm(selectedFlow);
                      return {
                        ...prev,
                        [selectedFlow.id]: updater(base),
                      };
                    })
                  }
                  onClearError={() => {
                    if (simpleErrors[selectedFlow.id]) {
                      setSimpleErrors(({ [selectedFlow.id]: _, ...prev }) => prev);
                    }
                  }}
                />
              ) : (
                <FlowFormFields
                  draft={simpleDraft}
                  inputClassName="flow-page__field-control"
                  errorMessage={simpleError}
                  onDraftChange={(updater) =>
                    setSimpleDrafts((prev) => {
                      const base = prev[selectedFlow.id] ?? flowToForm(selectedFlow);
                      return {
                        ...prev,
                        [selectedFlow.id]: updater(base),
                      };
                    })
                  }
                  onClearError={() => {
                    if (simpleErrors[selectedFlow.id]) {
                      setSimpleErrors(({ [selectedFlow.id]: _, ...prev }) => prev);
                    }
                  }}
                  normalizeMixPercent={normalizeMixPercent}
                  disabledSources={disabledFlowSources}
                />
              )}
            </Suspense>
            <div className="flow-page__recipe-actions">
              {flowHasChanges ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={applyingFlowId === selectedFlow.id}
                  onClick={() => handleCancelSimple(selectedFlow)}
                >
                  Cancel
                </button>
              ) : null}
              {flowHasChanges || applyingFlowId === selectedFlow.id ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={
                    !flowHasChanges || Boolean(simpleError) || applyingFlowId === selectedFlow.id
                  }
                  onClick={() => handleApplySimple(selectedFlow)}
                >
                  {applyingFlowId === selectedFlow.id ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : null}
                  Save recipe
                </button>
              ) : (
                <span className="flow-page__recipe-status" role="status">
                  <Check className="artist-icon-sm" aria-hidden="true" />
                  Saved
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  ) : null;

  const selectedDetailContent = selectedEntry ? (
    <>
      <PlaylistDetailHero
        entry={selectedEntry}
        artworkUrl={artworkUrlFor(selectedEntry.id)}
        metaLine={detailMetaLine}
        flowMeta={detailFlowMeta}
        activityHint={selectedActivityMessage}
        enabled={flowEnabled}
        togglingId={togglingId}
        onToggleEnabled={(checked) => selectedFlow && handleToggleRequest(selectedFlow, checked)}
        onRenameTitle={() => handleOpenEditModal()}
        onArtworkClick={() => handleOpenEditModal()}
        moreMenu={selectedDetailMoreMenu}
      />
      {selectedDetailBody}
    </>
  ) : null;

  return (
    <div className="flow-page">
      <div
        className={`flow-page__shell${!isMobileLayout && libraryCollapsed ? " flow-page__shell--library-collapsed" : ""}`}
      >
        <aside
          className={`flow-page__library${!isMobileLayout && libraryCollapsed ? " flow-page__library--collapsed" : ""}`}
        >
          <div className="flow-page__library-head">
            <button
              type="button"
              className="flow-page__library-collapse"
              onClick={() => {
                setLibraryCollapsed((prev) => {
                  const next = !prev;
                  try {
                    globalThis.localStorage?.setItem(
                      LIBRARY_SIDEBAR_COLLAPSED_KEY,
                      next ? "1" : "0",
                    );
                  } catch {}
                  return next;
                });
              }}
              aria-label={
                libraryCollapsed ? "Expand playlist sidebar" : "Collapse playlist sidebar"
              }
              title={libraryCollapsed ? "Expand playlist sidebar" : "Collapse playlist sidebar"}
            >
              <LibrarySidebarToggleIcon collapsed={libraryCollapsed} />
            </button>
            <h1 className="flow-page__library-title">{mode === "flows" ? "Flows" : "Playlists"}</h1>
            <FlowLibraryCreateMenu
              onImport={() => setImportModalOpen(true)}
              onNewPlaylist={handleOpenCreatePlaylist}
              onNewFlow={handleCreateInline}
              creatingPlaylist={creatingPlaylist}
              creatingFlow={creating}
              canCreateFlow={canCreateGeneratedFlow}
              showPlaylists={mode !== "flows"}
              showFlows={mode !== "playlists"}
              showImport={mode !== "flows"}
              compact={libraryCollapsed}
            />
          </div>
          {!fixedLibraryFilter ? (
            <div
              className="artist-segmented flow-page__library-filters"
              role="group"
              aria-label="Library filter"
            >
              {[
                { id: "all", label: "All" },
                { id: "playlists", label: "Playlists" },
                { id: "flows", label: "Flows" },
              ].map((filter) => {
                const isActive = libraryFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={`artist-segmented-button flow-page__library-filter${isActive ? " is-active" : ""}`}
                    aria-pressed={isActive}
                    onClick={() => setLibraryFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="flow-page__library-list">
            {filteredCollection.length === 0 ? (
              <FlowEmptyState
                canCreate={canCreateGeneratedFlow}
                libraryFilter={activeLibraryFilter}
                variant={isMobileLayout ? "full" : "compact"}
                onImport={() => setImportModalOpen(true)}
                onNewPlaylist={handleOpenCreatePlaylist}
                onNewFlow={handleCreateInline}
                creatingPlaylist={creatingPlaylist}
                creatingFlow={creating}
              />
            ) : (
              filteredCollection.map((entry) => {
                const stats = getPlaylistStats(entry.id);
                const isExpanded = isMobileLayout && mobileShowDetail && selectedId === entry.id;
                return (
                  <div
                    key={entry.id}
                    className={`flow-page__library-row${isExpanded ? " is-expanded" : ""}`}
                  >
                    <PlaylistLibraryItem
                      entry={entry}
                      artworkUrl={artworkUrlFor(entry.id)}
                      isActive={isMobileLayout ? isExpanded : selectedId === entry.id}
                      expanded={isExpanded}
                      stats={stats}
                      activityHint={getEntryActivityMessage(entry)}
                      collapsed={!isMobileLayout && libraryCollapsed}
                      onSelect={selectPlaylist}
                      viewerUsername={user?.username}
                      viewerIsAdmin={user?.role === "admin"}
                      trailing={
                        isExpanded ? (
                          <>
                            {entry.kind === "flow" ? (
                              <div className="flow-page__toggle-wrap" data-no-card-toggle="true">
                                <PillToggle
                                  checked={flowEnabled}
                                  className={`pill-toggle--flow-compact${flowEnabled ? "" : " is-off"}`}
                                  aria-label={`Enable ${selectedFlow?.name || "flow"}`}
                                  onChange={(event) =>
                                    selectedFlow &&
                                    handleToggleRequest(selectedFlow, event.target.checked)
                                  }
                                  disabled={togglingId === entry.id}
                                />
                              </div>
                            ) : null}
                            {selectedDetailMoreMenu}
                          </>
                        ) : null
                      }
                    />
                    {isExpanded ? (
                      <div className="flow-page__library-inline-detail">{selectedDetailBody}</div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {!isMobileLayout ? (
          <section
            className={`flow-page__detail${!selectedEntry ? " flow-page__detail--empty" : ""}`}
          >
            {!selectedEntry ? (
              filteredCollection.length === 0 ? (
                <FlowEmptyState
                  canCreate={canCreateGeneratedFlow}
                  libraryFilter={activeLibraryFilter}
                  variant="full"
                  onImport={() => setImportModalOpen(true)}
                  onNewPlaylist={handleOpenCreatePlaylist}
                  onNewFlow={handleCreateInline}
                  creatingPlaylist={creatingPlaylist}
                  creatingFlow={creating}
                />
              ) : (
                <div className="flow-page__detail-placeholder">
                  <div className="flow-page__detail-placeholder__icon" aria-hidden="true">
                    <ListMusic className="artist-icon-lg" />
                  </div>
                  <p className="flow-page__detail-placeholder__message">
                    Select a playlist or flow to view tracks and settings.
                  </p>
                </div>
              )
            ) : (
              selectedDetailContent
            )}
          </section>
        ) : null}
      </div>

      <ConfirmModal
        open={Boolean(confirmDelete)}
        title={confirmDelete ? `Delete ${confirmDelete.title}?` : ""}
        body={
          confirmDelete?.kind === "shared"
            ? "This removes the imported static playlist and any downloaded files tied to it."
            : "This removes the flow and its playlist setup. You can recreate it later."
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        busy={deletingId === confirmDelete?.flowId}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmModal
        open={Boolean(confirmDisable)}
        title={confirmDisable ? `Turn off ${confirmDisable.title}?` : ""}
        body="This pauses future runs. You can turn it back on anytime."
        confirmLabel="Turn Off"
        busyLabel="Turning off..."
        busy={togglingId === confirmDisable?.flowId}
        onCancel={() => setConfirmDisable(null)}
        onConfirm={handleConfirmDisable}
      />
      {importModalOpen ? (
        <Suspense fallback={null}>
          <PlaylistImportModal
            open={importModalOpen}
            onClose={() => setImportModalOpen(false)}
            onImported={fetchStatus}
            showError={showError}
            showSuccess={showSuccess}
            existingPlaylistNames={(status?.sharedPlaylists || []).map((playlist) => playlist?.name)}
          />
        </Suspense>
      ) : null}
      <RenamePlaylistModal
        open={!!renameModal}
        title={renameModal?.kind === "flow" ? "Edit flow" : "Edit playlist"}
        defaultName={renameModal?.name || ""}
        displayName={renameModal?.name || ""}
        artworkUrl={renameModal ? artworkUrlFor(renameModal.id) : ""}
        saving={renameModalSaving}
        coverBusy={coverArtworkBusyId === renameModal?.id}
        error={renameModalError}
        coverError={coverArtworkError}
        onClose={() => {
          if (renameModalSaving || coverArtworkBusyId) return;
          setRenameModal(null);
          setCoverArtworkError("");
        }}
        onSubmit={handleRenameModalSubmit}
        onUpload={handleUploadCover}
        onRemoveCover={handleRemoveCover}
        onGenerateCover={handleGenerateCover}
      />
      <CreatePlaylistModal
        open={isCreatePlaylistOpen}
        defaultName={getNextPlaylistName("Playlist")}
        saving={creatingPlaylist}
        error={createPlaylistError}
        onClose={() => {
          if (creatingPlaylist) return;
          setCreatePlaylistError("");
          setIsCreatePlaylistOpen(false);
        }}
        onSubmit={handleCreatePlaylist}
      />
    </div>
  );
}

export default FlowPage;
