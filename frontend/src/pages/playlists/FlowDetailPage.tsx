import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { lazy, Suspense, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
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
import { parseResponse } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.tsx";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.tsx";
import { formatFlowLastRun, getFlowDisplayTrackCount } from "./playlistStats";
import { normalizeNameKey, reserveUniqueName } from "./flowPageUtils";
import { PlaylistTracks } from "./PlaylistTracks.tsx";
import { usePlaylistTrackPlayback } from "./components/playlistTrackComponents.tsx";
import {
  describeFlowSchedule,
  formatFlowTrackLabel,
  formatTrackTotal,
  getFlowActivityMessage,
  usePlaylistTracks,
} from "./playlistPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";
import type { Flow } from "./playlistStats.ts";
import { asApiError } from "../../utils/api/core.ts";

const FlowEditor = lazy(() => import("./FlowEditor.tsx"));

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
              <SkeletonCollectionTracks toolbar={false} />
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
  const playback = usePlaylistTrackPlayback({
    tracks,
    playbackSource: {
      type: "flow",
      id: flow.id,
      label: flow.name || "Flow",
      recordHistory: flow.recordHistory !== false,
    },
  });
  const [editOpen, setEditOpen] = useState(location.state?.edit === true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);

  const stats = getPlaylistStats(flow.id);
  const enabled = flow.enabled === true;
  const savedCount = tracks.filter((track) => track.status === "saved").length;
  const activity = getFlowActivityMessage({ flow, status, stats, rerunning: running });
  const lastRun = formatFlowLastRun(flow.lastRunAt);
  const canRunNow = enabled && !running && !activity;
  const metaParts = [
    flow.ownerUsername || user?.username || null,
    formatFlowTrackLabel(getFlowDisplayTrackCount(flow, stats, tracks.length), stats),
    lastRun ? `Updated ${lastRun}` : null,
    describeFlowSchedule(flow, countdownNow),
  ];

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

  return (
    <CollectionPage tintSrc={artworkUrlFor(flow.id)} className="playlist-page">
      <CollectionHeader
        cover={
          <button
            type="button"
            className="playlist-detail__cover"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${flow.name}`}
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
            <TooltipButton
              className="native-library-icon-button"
              label="Edit flow"
              onClick={() => setEditOpen(true)}
            >
              <Pencil aria-hidden="true" />
            </TooltipButton>
            <LibraryItemMenu
              label={flow.name}
              contextMenu={false}
              items={[
                {
                  id: "edit",
                  label: "Edit flow",
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

      <div className="playlist-detail__panel">
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
      </div>

      {editOpen ? (
        <Suspense fallback={null}>
          <FlowEditor flowId={flow.id} onClose={() => setEditOpen(false)} />
        </Suspense>
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
    </CollectionPage>
  );
}
