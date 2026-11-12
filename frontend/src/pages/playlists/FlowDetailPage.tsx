import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Ban,
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
  SkeletonTrackList,
} from "../../components/Skeletons";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../../components/CollectionHeader";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import { usePlaylistPluginActions } from "../../hooks/usePluginActions.ts";
import TooltipButton from "../../components/TooltipButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { parseResponse } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { PlaylistArtworkThumb } from "../../components/PlaylistArtworkThumb.tsx";
import { useFlowEnabled } from "./FlowEnabledSwitch.tsx";
import { getFlowDisplayTrackCount } from "../../utils/playlistStats";
import { formatAlbumDuration } from "../ArtistDetails/utils";
import { describeFlowRecipe, formatFlowFreshness, formatFlowSchedule } from "./flowPageUtils";
import { PlaylistTracks } from "./PlaylistTracks.tsx";
import { usePlaylistTrackPlayback } from "./components/playlistTrackComponents.tsx";
import { formatTrackTotal, getFlowActivity, usePlaylistTracks } from "./playlistPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";
import type { Flow } from "../../utils/playlistStats.ts";
import { asApiError } from "../../utils/api/core.ts";
import { copyText } from "../../utils/shareLink.ts";
import { routeStateOf } from "../../navigation/routeState.ts";
import { normalizeNameKey, reserveUniqueName } from "../../utils/staticPlaylists.ts";

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
              <strong>Couldn&apos;t load this flow</strong>
              <span>Aurral didn&apos;t answer. Check that the server is running.</span>
              <button type="button" className="native-library-state__action" onClick={fetchStatus}>
                Try again
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
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, fetchStatus, getPlaylistStats, countdownNow, staticPlaylists } =
    usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const { tracks, loading, error, refresh } = usePlaylistTracks(flow.id);
  const pluginActions = usePlaylistPluginActions(flow.id);
  const playback = usePlaylistTrackPlayback({
    tracks,
    playbackSource: {
      type: "flow",
      id: flow.id,
      label: flow.name || "Flow",
      recordHistory: flow.recordHistory !== false,
    },
  });
  const [editOpen, setEditOpen] = useState(routeStateOf(location.state).edit === true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);

  const stats = getPlaylistStats(flow.id);
  const trackCount = getFlowDisplayTrackCount(flow, stats, tracks.length);
  const onOff = useFlowEnabled(flow, { trackCount: tracks.length, onChanged: fetchStatus });
  const enabled = flow.enabled === true;
  const savedCount = tracks.filter((track) => track.status === "saved").length;
  const activity = getFlowActivity({ flow, status, stats, rerunning: running });
  const refreshing = activity !== null && !["downloading", "queued"].includes(activity.phase);
  const statusTrackCount = Number(stats?.total || 0);
  const building =
    enabled &&
    tracks.length === 0 &&
    (refreshing ||
      onOff.awaitingRun ||
      !flow.lastRunAt ||
      statusTrackCount > 0 ||
      status?.operationQueue?.processing === true);
  const statusCounts = [
    flow.enabled,
    flow.lastRunAt,
    stats?.total,
    stats?.pending,
    stats?.downloading,
    stats?.blocked,
    stats?.done,
    stats?.failed,
  ].join(":");
  const seenStatusCounts = useRef(statusCounts);
  useEffect(() => {
    if (seenStatusCounts.current === statusCounts) return;
    seenStatusCounts.current = statusCounts;
    void refresh();
  }, [statusCounts, refresh]);
  const owner =
    flow.ownerUsername && flow.ownerUsername !== user?.username ? flow.ownerUsername : null;
  const duration = formatAlbumDuration(
    tracks.reduce((total, track) => total + Number(track.durationMs || 0), 0),
  );
  const facts = enabled
    ? [
        owner,
        formatFlowFreshness(flow.lastRunAt, countdownNow),
        tracks.length > 0
          ? [formatTrackTotal(trackCount), duration].filter(Boolean).join(", ")
          : null,
        formatFlowSchedule(flow.scheduleDays, flow.scheduleTime),
      ]
    : [owner];
  const canRefresh = enabled && !running && !activity;

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await parseResponse(
        flowsClient.start[":flowId"].$post({
          param: { flowId: encodeURIComponent(flow.id) },
          json: { limit: flow.size },
        }),
      );
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to refresh flow"));
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
      if (!(await copyText(url.toString())))
        throw new Error("Could not copy the Lidarr import URL");
      showSuccess("Copied Lidarr import URL");
    } catch (err) {
      showError(asApiError(err)?.message || "Failed to copy Lidarr import URL");
    }
  };

  const editButton = (
    <TooltipButton
      className="native-library-icon-button"
      label="Edit flow"
      onClick={() => setEditOpen(true)}
    >
      <Pencil aria-hidden="true" />
    </TooltipButton>
  );

  return (
    <CollectionPage tintSrc={artworkUrlFor(flow.id)} className="playlist-page">
      <CollectionHeader
        cover={
          <button
            type="button"
            className={`playlist-detail__cover${enabled ? "" : " is-off"}`}
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${flow.name}`}
          >
            <PlaylistArtworkThumb
              sizes="18rem"
              artworkUrl={artworkUrlFor(flow.id)}
              name={flow.name}
            />
          </button>
        }
        title={flow.name}
        subtitle={describeFlowRecipe(flow)}
        meta={facts.filter(Boolean).join(" · ")}
        status={
          !enabled ? (
            <p className="native-library-detail__meta playlist-detail__activity">
              Off. Turn it on to build a new mix.
            </p>
          ) : building || refreshing ? (
            <p className="native-library-detail__meta playlist-detail__activity" role="status">
              <RefreshCw aria-hidden="true" />
              {building
                ? flow.lastRunAt
                  ? "Building a new mix…"
                  : "Building your first mix…"
                : activity?.message}
            </p>
          ) : null
        }
        actions={
          <>
            {enabled ? (
              <>
                <CollectionPlayButtons
                  label={flow.name}
                  disabled={playback.disabled}
                  isPlaying={playback.isListPlaying}
                  isShuffleEnabled={playback.isShuffleEnabled}
                  onPlay={playback.handlePlayAll}
                  onShuffle={playback.handleShufflePlay}
                />
                <TooltipButton
                  className="native-library-icon-button"
                  onClick={() => canRefresh && handleRunNow()}
                  aria-disabled={!canRefresh}
                  label={canRefresh ? "Refresh now" : "Refreshing"}
                >
                  {running ? (
                    <DotLoader size="sm" label={null} />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                </TooltipButton>
              </>
            ) : (
              <button
                type="button"
                className="native-library-page-play"
                disabled={onOff.pending}
                onClick={() => onOff.setEnabled(true)}
              >
                {onOff.pending ? <DotLoader size="sm" label={null} /> : null}
                Turn on
              </button>
            )}
            {editButton}
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
                        label: `Download ${formatTrackTotal(savedCount)}`,
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
                {
                  id: "lidarr-url",
                  label: "Copy Lidarr import URL",
                  icon: ClipboardCopy,
                  onSelect: handleCopyLidarrUrl,
                },
                ...pluginActions,
                ...(enabled
                  ? [
                      {
                        id: "turn-off",
                        label: "Turn off",
                        icon: Ban,
                        separatorBefore: true,
                        disabled: onOff.pending,
                        onSelect: () => onOff.setEnabled(false),
                      },
                    ]
                  : []),
                {
                  id: "delete",
                  label: "Delete flow",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: !enabled,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
            />
          </>
        }
      />

      {enabled || tracks.length > 0 ? (
        <div className="playlist-detail__panel">
          {!loading && !error && tracks.length === 0 ? (
            building ? (
              <SkeletonStatus label="Building your first mix">
                <SkeletonTrackList count={4} />
              </SkeletonStatus>
            ) : (
              <div className="native-library-state">
                <strong>This refresh found no tracks</strong>
                <span>Try fewer tags, a wider year range, or another source.</span>
                <button
                  type="button"
                  className="native-library-state__action"
                  onClick={() => setEditOpen(true)}
                >
                  Edit flow
                </button>
              </div>
            )
          ) : (
            <PlaylistTracks
              entry={flow}
              kind="flow"
              tracks={tracks}
              loading={loading}
              error={error}
              refresh={refresh}
              staticPlaylists={staticPlaylists}
              fetchStatus={fetchStatus}
              recordHistory={flow.recordHistory !== false}
            />
          )}
        </div>
      ) : null}

      {editOpen ? (
        <Suspense fallback={null}>
          <FlowEditor flowId={flow.id} onClose={() => setEditOpen(false)} />
        </Suspense>
      ) : null}
      {onOff.confirmModal}
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${flow.name}?`}
        body="Removes this flow, its tracks, and its schedule."
        confirmLabel="Delete flow"
        busyLabel="Deleting…"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </CollectionPage>
  );
}
