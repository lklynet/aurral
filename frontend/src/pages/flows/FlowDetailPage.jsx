import { lazy, Suspense, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Check, ClipboardCopy, Download, FilePlus2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import { CollectionHeader, CollectionPage, CollectionPlayButtons } from "../../components/CollectionHeader";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import {
  convertFlowToStaticPlaylist,
  deleteFlow,
  getFlowLidarrImportListUrl,
  startFlowPlaylist,
  updateFlow,
} from "../../utils/api/endpoints/playlists.js";
import { getApiErrorMessage } from "../onboardingUtils.jsx";
import { ConfirmModal } from "./flowComponents/ConfirmModal.jsx";
import { PlaylistArtworkThumb } from "./flowComponents/PlaylistArtworkThumb.jsx";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.jsx";
import {
  formatFlowLastRun,
  getFlowDisplayTrackCount,
  isEditorialFlow,
  isReleaseRadarFlow,
} from "./flowStats";
import {
  buildEditorialFlowFromForm,
  buildFlowFromForm,
  buildReleaseRadarFlowFromForm,
  flowToForm,
  getUnavailableFlowSourceMessage,
  isFlowDirty,
  isScheduleOnlyFlowDirty,
  normalizeMixPercent,
  normalizeNameKey,
  reserveUniqueFlowName,
} from "./flowPageUtils";
import { PlaylistEditModal } from "./PlaylistEditModal.jsx";
import { PlaylistTracks } from "./PlaylistTracks.jsx";
import { useFlowTrackPlayback } from "./flowComponents/flowTrackComponents.jsx";
import {
  describeFlowSchedule,
  formatFlowTrackLabel,
  exportPlaylistTracklist,
  getFlowActivityMessage,
  optionMenuItem,
  usePlaylistArtwork,
  usePlaylistTracks,
} from "./playlistShared";
import { useFlowStatus } from "./useFlowStatus";

const FlowFormFields = lazy(() =>
  import("./flowComponents/flowFormComponents.jsx").then((m) => ({ default: m.FlowFormFields })),
);
const ReleaseRadarRecipeFields = lazy(() =>
  import("./flowComponents/flowFormComponents.jsx").then((m) => ({
    default: m.ReleaseRadarRecipeFields,
  })),
);
const EditorialRecipeFields = lazy(() =>
  import("./flowComponents/flowFormComponents.jsx").then((m) => ({
    default: m.EditorialRecipeFields,
  })),
);

const DETAIL_TABS = [
  { id: "tracks", label: "Tracks" },
  { id: "recipe", label: "Recipe" },
];

export default function FlowDetailPage() {
  const { flowId } = useParams();
  const { status, loading, error, fetchStatus, flows } = useFlowStatus();
  const flow = flows.find((entry) => entry.id === flowId) || null;
  useDocumentTitle(flow?.name || "Flow");

  if (!flow) {
    return (
      <main className="library-page native-library-page playlist-page">
        <div className="native-library-content">
          {loading && !status ? (
            <div className="native-library-state" role="status">
              <DotLoader size="xl" label={null} />
              <span>Loading flow…</span>
            </div>
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
      </main>
    );
  }

  return <FlowDetail key={flow.id} flow={flow} />;
}

function FlowDetail({ flow }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, fetchStatus, getPlaylistStats, countdownNow, sharedPlaylists } = useFlowStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const { tracks, loading, error, refresh } = usePlaylistTracks(flow.id);
  const [tab, setTab] = useState(location.state?.tab === "recipe" ? "recipe" : "tracks");
  const [draft, setDraft] = useState(() => flowToForm(flow));
  const [recipeError, setRecipeError] = useState("");
  const [savingRecipe, setSavingRecipe] = useState(false);
  const playback = useFlowTrackPlayback({
    tracks,
    playbackSource: {
      type: "flow",
      id: flow.id,
      label: flow.name || "Flow",
      recordHistory: flow.recordHistory !== false,
    },
  });
  const [editOpen, setEditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);

  const stats = getPlaylistStats(flow.id);
  const enabled = flow.enabled === true;
  const disabledSources = status?.capabilities?.unavailableSources || {};
  const isPresetRecipe = isReleaseRadarFlow(flow) || isEditorialFlow(flow);
  const recipeDirty = isPresetRecipe
    ? isScheduleOnlyFlowDirty(flow, draft)
    : isFlowDirty(flow, draft);
  const activity = getFlowActivityMessage({ flow, status, stats, rerunning: running });
  const lastRun = formatFlowLastRun(flow.lastRunAt);
  const metaParts = [
    flow.ownerUsername || user?.username || null,
    formatFlowTrackLabel(getFlowDisplayTrackCount(flow, stats, tracks.length), stats),
    lastRun ? `Updated ${lastRun}` : null,
    describeFlowSchedule(flow, countdownNow),
  ];

  const handleRunNow = async () => {
    setRunning(true);
    try {
      const response = await startFlowPlaylist(flow.id, flow.size);
      const queued = Number(response?.tracksQueued || 0);
      showSuccess(queued > 0 ? `${flow.name} queued ${queued} tracks` : `${flow.name} run started`);
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
      if (!isPresetRecipe) {
        const sourceError = getUnavailableFlowSourceMessage(draft, disabledSources);
        if (sourceError) throw new Error(sourceError);
      }
      const payload = isReleaseRadarFlow(flow)
        ? buildReleaseRadarFlowFromForm(flow, draft)
        : isEditorialFlow(flow)
          ? buildEditorialFlowFromForm(flow, draft)
          : buildFlowFromForm(draft);
      const response = await updateFlow(flow.id, payload);
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

  const handleRename = async (name) => {
    setRenaming(true);
    setRenameError("");
    try {
      const nextName = String(name ?? "").trim();
      await updateFlow(flow.id, { name: nextName });
      setDraft((current) => ({ ...current, name: nextName }));
      showSuccess("Flow renamed");
      await fetchStatus();
      setEditOpen(false);
    } catch (err) {
      const message = getApiErrorMessage(err, "Failed to rename flow");
      setRenameError(message);
      showError(message);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteFlow(flow.id);
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
        sharedPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean),
      );
      const response = await convertFlowToStaticPlaylist(flow.id, {
        name: reserveUniqueFlowName(reservedNames, `${flow.name} Static`),
      });
      showSuccess(`Saved ${flow.name} as ${response?.playlist?.name || "a playlist"}`);
      await fetchStatus();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to save flow as a playlist"));
    }
  };

  const handleExport = () => {
    try {
      exportPlaylistTracklist(flow, tracks, { sourceFlowId: flow.id });
      showSuccess(`Exported ${flow.name} tracklist`);
    } catch (err) {
      showError(err?.message || "Failed to export tracklist");
    }
  };

  const handleCopyLidarrUrl = async () => {
    try {
      const response = await getFlowLidarrImportListUrl(flow.id);
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
      showError(err?.message || "Failed to copy Lidarr import URL");
    }
  };

  const updateSetting = async (changes, successMessage) => {
    try {
      await updateFlow(flow.id, changes);
      setDraft((current) => ({ ...current, ...changes }));
      showSuccess(successMessage);
      await fetchStatus();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to update flow setting"));
    }
  };

  const recipeFieldProps = {
    draft,
    inputClassName: "flow-page__field-control",
    errorMessage: recipeError,
    onDraftChange: (updater) => setDraft((current) => updater(current)),
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
        kicker="Flow"
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
            <button
              type="button"
              className="collection-header__action"
              onClick={handleRunNow}
              disabled={!enabled || running || Boolean(activity)}
            >
              {running ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
              Run now
            </button>
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
                {
                  id: "convert",
                  label: "Save as playlist",
                  icon: FilePlus2,
                  disabled: Number(stats?.done || 0) === 0,
                  onSelect: handleConvertToStatic,
                },
                {
                  id: "export",
                  label: "Export tracklist",
                  icon: Download,
                  disabled: tracks.length === 0,
                  onSelect: handleExport,
                },
                optionMenuItem({
                  id: "scrobble",
                  label: "Scrobble tracks",
                  checked: flow.recordHistory !== false,
                  separatorBefore: true,
                  onSelect: () =>
                    updateSetting(
                      { recordHistory: flow.recordHistory === false },
                      flow.recordHistory === false ? "Scrobbling turned on" : "Scrobbling turned off",
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
                {
                  id: "lidarr-url",
                  label: "Copy Lidarr import URL",
                  icon: ClipboardCopy,
                  separatorBefore: true,
                  onSelect: handleCopyLidarrUrl,
                },
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
        <div className="artist-segmented playlist-detail__tabs" role="tablist" aria-label="Flow views">
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
              sharedPlaylists={sharedPlaylists}
              fetchStatus={fetchStatus}
              activityHint={activity}
              emptyMessage={
                enabled
                  ? "No tracks generated for this flow yet."
                  : "Turn this flow on to generate tracks."
              }
              recordHistory={flow.recordHistory !== false}
            />
          ) : null}
          {tab === "recipe" ? (
            <div className="flow-page__form flow-page__detail-recipe">
              <Suspense fallback={null}>
                {isReleaseRadarFlow(flow) ? (
                  <ReleaseRadarRecipeFields {...recipeFieldProps} />
                ) : isEditorialFlow(flow) ? (
                  <EditorialRecipeFields {...recipeFieldProps} tag={flow.tag || ""} />
                ) : (
                  <FlowFormFields
                    {...recipeFieldProps}
                    normalizeMixPercent={normalizeMixPercent}
                    disabledSources={disabledSources}
                  />
                )}
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

      <PlaylistEditModal
        entry={flow}
        title="Edit flow"
        open={editOpen}
        saving={renaming}
        error={renameError}
        onClose={() => {
          setRenameError("");
          setEditOpen(false);
        }}
        onRename={handleRename}
      />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${flow.name}?`}
        body="This removes the flow and its playlist setup. You can recreate it later."
        confirmLabel="Delete flow"
        busyLabel="Deleting…"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </CollectionPage>
  );
}
