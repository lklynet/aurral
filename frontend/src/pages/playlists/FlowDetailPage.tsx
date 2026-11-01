import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { lazy, Suspense, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Check,
  ClipboardCopy,
  Download,
  FilePlus2,
  Pencil,
  RefreshCw,
  Trash2,
} from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import {
  SkeletonCollectionHeader,
  SkeletonCollectionTracks,
  SkeletonStatus,
} from "../../components/Skeletons";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../../components/CollectionHeader";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import TooltipButton from "../../components/TooltipButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useLibraryDestination } from "../../hooks/useLibraryDestination";
import { parseResponse, type InferRequestType } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../onboardingUtils.tsx";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.tsx";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.tsx";
import { formatFlowLastRun, getFlowDisplayTrackCount } from "./playlistStats";
import {
  buildFlowFromForm,
  flowToForm,
  isFlowDirty,
  normalizeNameKey,
  reserveUniqueName,
} from "./flowPageUtils";
import { PlaylistEditModal } from "./PlaylistEditModal.tsx";
import { PlaylistTracks } from "./PlaylistTracks.tsx";
import { usePlaylistTrackPlayback } from "./components/playlistTrackComponents.tsx";
import {
  describeFlowSchedule,
  formatFlowTrackLabel,
  formatTrackTotal,
  getFlowActivityMessage,
  optionMenuItem,
  usePlaylistTracks,
} from "./playlistPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";
import type { Flow } from "./playlistStats.ts";
import type { FlowDraft } from "./flowPageUtils.ts";
import { asApiError } from "../../utils/api/core.ts";

const FlowFormFields = lazy(() =>
  import("./components/flowFormComponents.tsx").then((m) => ({ default: m.FlowFormFields })),
);

const DETAIL_TABS = [
  { id: "tracks", label: "Tracks" },
  { id: "recipe", label: "Recipe" },
];

export default function FlowDetailPage() {
  const { flowId } = useParams();
  const { status, loading, error, fetchStatus, flows } = usePlaylistStatus();
  const flow = flows.find((entry) => entry.id === flowId) || null;
  useDocumentTitle(flow?.name || "Flow");

  if (!flow) {
    return (
      <div className="library-page native-library-page playlist-page">
        <div className="native-library-content">
          {loading && !status ? (
            <SkeletonStatus label="Loading flow" className="native-library-detail">
              <SkeletonCollectionHeader icons={3} />
              <div>
                <div className="artist-segmented playlist-detail__tabs">
                  <span className="artist-segmented-button is-active">Tracks</span>
                  <span className="artist-segmented-button">Recipe</span>
                </div>
                <div className="playlist-detail__panel">
                  <SkeletonCollectionTracks toolbar={false} />
                </div>
              </div>
            </SkeletonStatus>
          ) : error && !status ? (
            <div className="native-library-state" role="alert">
              <strong>Flow unavailable</strong>
              <span>Aurral could not load this flow.</span>
              <button type="button" className="native-library-state__action" onClick={fetchStatus}>
                Retry
              </button>
            </div>
          ) : (
            <div className="native-library-state">
              <strong>Flow not found</strong>
              <span>It may have been deleted.</span>
              <Link to="/flows" className="native-library-state__action">
                Back to flows
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  return <FlowDetail key={flow.id} flow={flow} />;
}

function FlowDetail({ flow }: { flow: Flow }) {
  const lidarrConnected = useLibraryDestination().primary === "lidarr";
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, fetchStatus, getPlaylistStats, countdownNow, staticPlaylists } =
    usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const { tracks, loading, error, refresh } = usePlaylistTracks(flow.id);
  const [tab, setTab] = useState(location.state?.tab === "recipe" ? "recipe" : "tracks");
  const [draft, setDraft] = useState<FlowDraft>(() => flowToForm(flow));
  const [recipeError, setRecipeError] = useState("");
  const [savingRecipe, setSavingRecipe] = useState(false);
  const playback = usePlaylistTrackPlayback({
    tracks,
    playbackSource: {
      type: "flow",
      id: flow.id,
      label: flow.name || "Flow",
      recordHistory: flow.recordHistory !== false,
    },
  });
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmDownloadSaved, setConfirmDownloadSaved] = useState(false);
  const [downloadingSaved, setDownloadingSaved] = useState(false);

  const stats = getPlaylistStats(flow.id);
  const enabled = flow.enabled === true;
  const savedCount = tracks.filter((track) => track.status === "saved").length;
  const recipeDirty = isFlowDirty(flow, draft);
  const activity = getFlowActivityMessage({ flow, status, stats, rerunning: running });
  const lastRun = formatFlowLastRun(flow.lastRunAt);
  const canRunNow = enabled && !running && !activity;
  const metaParts = [
    flow.ownerUsername || user?.username || null,
    formatFlowTrackLabel(getFlowDisplayTrackCount(flow, stats, tracks.length), stats),
    lastRun ? `Updated ${lastRun}` : null,
    describeFlowSchedule(flow, countdownNow),
  ];

  const updateFlow = (
    json: InferRequestType<(typeof flowsClient.flows)[":flowId"]["$put"]>["json"],
  ) =>
    parseResponse(
      flowsClient.flows[":flowId"].$put({ param: { flowId: encodeURIComponent(flow.id) }, json }),
    );

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await parseResponse(
        flowsClient.start[":flowId"].$post({
          param: { flowId: encodeURIComponent(flow.id) },
          json: { limit: flow.size },
        }),
      );
      showSuccess(`${flow.name} run started`);
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to run flow"));
    } finally {
      setRunning(false);
    }
  };

  const handleSaveRecipe = async () => {
    setSavingRecipe(true);
    setRecipeError("");
    try {
      const payload = buildFlowFromForm(draft);
      const response = await updateFlow(payload);
      setDraft(flowToForm(response?.flow || { ...flow, ...payload }));
      showSuccess("Recipe saved");
      await fetchStatus();
    } catch (err) {
      const message = getApiErrorMessage(err, "Failed to save recipe");
      setRecipeError(message);
      showError(message);
    } finally {
      setSavingRecipe(false);
    }
  };

  const handleRename = async (name: string) => {
    await updateFlow({ name });
    setDraft((current) => ({ ...current, name }));
    await fetchStatus();
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await parseResponse(
        flowsClient.flows[":flowId"].$delete({ param: { flowId: encodeURIComponent(flow.id) } }),
      );
      showSuccess(result?.queued ? `Removal of ${flow.name} queued` : `Deleted ${flow.name}`);
      await fetchStatus();
      navigate("/flows", { replace: true });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to delete flow"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleConvertToStatic = async () => {
    try {
      const reservedNames = new Set(
        staticPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean),
      );
      const response = await parseResponse(
        flowsClient.flows[":flowId"]["static-playlist"].$post({
          param: { flowId: encodeURIComponent(flow.id) },
          json: { name: reserveUniqueName(reservedNames, `${flow.name} Static`) },
        }),
      );
      showSuccess(`Saved ${flow.name} as ${response?.playlist?.name || "a playlist"}`);
      await fetchStatus();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to save flow as a playlist"));
    }
  };

  const handleDownloadSaved = async () => {
    try {
      await parseResponse(
        flowsClient.flows[":flowId"].download.$post({
          param: { flowId: encodeURIComponent(flow.id) },
        }),
      );
      showSuccess(`Downloading ${formatTrackTotal(savedCount)}`);
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to download flow tracks"));
    }
  };

  const handleCopyLidarrUrl = async () => {
    try {
      const response = await parseResponse(
        flowsClient.flows[":flowId"]["lidarr-import-list"].$get({
          param: { flowId: encodeURIComponent(flow.id) },
        }),
      );
      const token = String(response?.token || "").trim();
      if (!token) throw new Error("Feed URL unavailable");
      const url = new URL(
        `/api/feeds/lidarr/flows/${encodeURIComponent(flow.id)}.json`,
        window.location.origin,
      );
      url.searchParams.set("token", token);
      await navigator.clipboard.writeText(url.toString());
      showSuccess("Copied Lidarr import URL");
    } catch (err) {
      showError(asApiError(err)?.message || "Failed to copy Lidarr import URL");
    }
  };

  const updateSetting = async (
    changes: { recordHistory?: boolean; showInLibrary?: boolean; autoDownload?: boolean },
    successMessage: string,
  ) => {
    try {
      await updateFlow(changes);
      setDraft((current) => ({ ...current, ...changes }));
      showSuccess(successMessage);
      await fetchStatus();
      return true;
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to update flow setting"));
      return false;
    }
  };

  const enableAutoDownload = async () => {
    if (await updateSetting({ autoDownload: true }, "New tracks will download automatically"))
      setConfirmDownloadSaved(savedCount > 0);
  };

  const downloadSavedNow = async () => {
    setDownloadingSaved(true);
    await handleDownloadSaved();
    setDownloadingSaved(false);
    setConfirmDownloadSaved(false);
  };

  const recipeFieldProps = {
    draft,
    inputClassName: "flow-page__field-control",
    errorMessage: recipeError,
    onDraftChange: (updater: (prev: FlowDraft) => FlowDraft) =>
      setDraft((current) => updater(current)),
    onClearError: () => setRecipeError(""),
  };

  return (
    <CollectionPage tintSrc={artworkUrlFor(flow.id)} className="playlist-page">
      <CollectionHeader
        cover={
          <button
            type="button"
            className="playlist-detail__cover"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${flow.name} details`}
          >
            <PlaylistArtworkThumb artworkUrl={artworkUrlFor(flow.id)} name={flow.name} />
          </button>
        }
        corner={
          <TooltipButton
            className="native-library-icon-button"
            onClick={() => canRunNow && handleRunNow()}
            aria-disabled={!canRunNow}
            label={
              !enabled
                ? "Turn the flow on to run it"
                : running || activity
                  ? "Flow is running"
                  : "Run now"
            }
          >
            {running ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
          </TooltipButton>
        }
        title={flow.name}
        meta={metaParts.filter(Boolean).join(" · ")}
        status={
          activity ? (
            <p className="native-library-detail__meta playlist-detail__activity" role="status">
              <DotLoader size="xs" label={null} />
              {activity}
            </p>
          ) : null
        }
        actions={
          <>
            <CollectionPlayButtons
              label={flow.name}
              disabled={playback.disabled}
              isPlaying={playback.isListPlaying}
              isShuffleEnabled={playback.isShuffleEnabled}
              onPlay={playback.handlePlayAll}
              onShuffle={playback.handleShufflePlay}
            />
            <span className="playlist-detail__switch">
              <FlowEnabledSwitch flow={flow} onChanged={fetchStatus} />
              <span aria-hidden="true">{enabled ? "On" : "Off"}</span>
            </span>
            <LibraryItemMenu
              label={flow.name}
              contextMenu={false}
              items={[
                {
                  id: "edit",
                  label: "Edit details",
                  icon: Pencil,
                  onSelect: () => setEditOpen(true),
                },
                ...(savedCount > 0
                  ? [
                      {
                        id: "download",
                        label: "Download all",
                        icon: Download,
                        onSelect: handleDownloadSaved,
                      },
                    ]
                  : []),
                {
                  id: "convert",
                  label: "Save as playlist",
                  icon: FilePlus2,
                  disabled: Number(stats?.done || 0) === 0,
                  onSelect: handleConvertToStatic,
                },
                optionMenuItem({
                  id: "auto-download",
                  label: "Download automatically",
                  checked: flow.autoDownload !== false,
                  separatorBefore: true,
                  onSelect: () =>
                    flow.autoDownload === false
                      ? enableAutoDownload()
                      : updateSetting(
                          { autoDownload: false },
                          "New tracks will wait for you to download them",
                        ),
                }),
                optionMenuItem({
                  id: "scrobble",
                  label: "Scrobble tracks",
                  checked: flow.recordHistory !== false,
                  onSelect: () =>
                    updateSetting(
                      { recordHistory: flow.recordHistory === false },
                      flow.recordHistory === false
                        ? "Scrobbling turned on"
                        : "Scrobbling turned off",
                    ),
                }),
                optionMenuItem({
                  id: "show-in-library",
                  label: "Show in library",
                  checked: flow.showInLibrary === true,
                  onSelect: () =>
                    updateSetting(
                      { showInLibrary: flow.showInLibrary !== true },
                      flow.showInLibrary === true ? "Hidden from library" : "Shown in library",
                    ),
                }),
                ...(lidarrConnected
                  ? [
                      {
                        id: "lidarr-url",
                        label: "Copy Lidarr import URL",
                        icon: ClipboardCopy,
                        separatorBefore: true,
                        onSelect: handleCopyLidarrUrl,
                      },
                    ]
                  : []),
                {
                  id: "delete",
                  label: "Delete flow",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
            />
          </>
        }
      />

      <div>
        <div
          className="artist-segmented playlist-detail__tabs"
          role="tablist"
          aria-label="Flow views"
        >
          {DETAIL_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`flow-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`flow-panel-${entry.id}`}
              className={`artist-segmented-button${tab === entry.id ? " is-active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {entry.id === "recipe" && recipeDirty ? (
                <span className="playlist-detail__dirty" aria-label="Unsaved changes" />
              ) : null}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`flow-panel-${tab}`}
          aria-labelledby={`flow-tab-${tab}`}
          className="playlist-detail__panel"
        >
          {tab === "tracks" ? (
            <PlaylistTracks
              entry={flow}
              kind="flow"
              tracks={tracks}
              loading={loading}
              error={error}
              refresh={refresh}
              staticPlaylists={staticPlaylists}
              fetchStatus={fetchStatus}
              activityHint={activity}
              emptyMessage={enabled ? "No tracks yet." : "Turn this flow on to generate tracks."}
              recordHistory={flow.recordHistory !== false}
            />
          ) : null}
          {tab === "recipe" ? (
            <div className="flow-page__form flow-page__detail-recipe">
              <Suspense fallback={null}>
                <FlowFormFields {...recipeFieldProps} />
              </Suspense>
              <div className="flow-page__recipe-actions">
                {recipeDirty ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={savingRecipe}
                      onClick={() => {
                        setDraft(flowToForm(flow));
                        setRecipeError("");
                      }}
                    >
                      Discard changes
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={savingRecipe || Boolean(recipeError)}
                      onClick={handleSaveRecipe}
                    >
                      {savingRecipe ? <DotLoader size="sm" label={null} /> : null}
                      Save recipe
                    </button>
                  </>
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
      </div>

      {editOpen ? (
        <PlaylistEditModal
          entry={flow}
          title="Edit flow"
          onClose={() => setEditOpen(false)}
          onRename={handleRename}
        />
      ) : null}
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${flow.name}?`}
        body="Removes this flow and its playlist setup."
        confirmLabel="Delete flow"
        busyLabel="Deleting…"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
      <ConfirmModal
        open={confirmDownloadSaved}
        title={`Download ${formatTrackTotal(savedCount)} already in this flow?`}
        body="New tracks will download automatically from now on."
        confirmLabel="Download now"
        cancelLabel="Not now"
        tone="primary"
        busyLabel="Downloading"
        busy={downloadingSaved}
        onCancel={() => setConfirmDownloadSaved(false)}
        onConfirm={downloadSavedNow}
      />
    </CollectionPage>
  );
}
