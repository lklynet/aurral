import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { useState } from "react";
import RouteLink from "../../components/RouteLink";
import { Clock, Download, Plus, RefreshCw } from "../../components/icons";
import { SkeletonShape, SkeletonStatus, SkeletonText } from "../../components/Skeletons";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { PlaylistArtworkThumb } from "../../components/PlaylistArtworkThumb.tsx";
import { describeFlowRecipe, formatFlowSchedule } from "./flowPageUtils";
import { getFlowActivity } from "./playlistPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";
import { flowPath } from "../../navigation/playlistPaths";
import type { Flow } from "../../utils/playlistStats.ts";
import { FlowStarters, NewFlowModal } from "./FlowStarters.tsx";

export default function FlowsPage() {
  useDocumentTitle("Flows");
  const { user } = useAuth();
  const { status, loading, error, fetchStatus, getPlaylistStats, flows } = usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [newFlowOpen, setNewFlowOpen] = useState(false);

  const renderStatus = (flow: Flow) => {
    const stats = getPlaylistStats(flow.id);
    const activity = getFlowActivity({ flow, status, stats });
    if (activity) {
      const Icon =
        activity.phase === "downloading"
          ? Download
          : activity.phase === "queued"
            ? Clock
            : RefreshCw;
      return (
        <>
          <Icon aria-hidden="true" />
          {activity.message}
        </>
      );
    }
    if (flow.enabled !== true) return "Off";
    const missing = Number(stats?.failed || 0);
    if (missing > 0) return <span className="flows-list__warning">{missing} missing</span>;
    return formatFlowSchedule(flow.scheduleDays, flow.scheduleTime);
  };

  const renderContent = () => {
    if (loading && !status) {
      return (
        <SkeletonStatus label="Loading flows">
          <ul className="flows-list">
            {["9em", "7em", "11em"].map((width) => (
              <li key={width}>
                <div className="flows-list__link">
                  <SkeletonShape className="flow-page__artwork flows-list__art" />
                  <span className="flows-list__name">
                    <SkeletonText width={width} />
                  </span>
                  <span className="flows-list__recipe">
                    <SkeletonText width="14em" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </SkeletonStatus>
      );
    }
    if (error && !status) {
      return (
        <div className="native-library-state" role="alert">
          <strong>Couldn&apos;t load flows</strong>
          <span>Aurral didn&apos;t answer. Check that the server is running.</span>
          <button type="button" className="native-library-state__action" onClick={fetchStatus}>
            Try again
          </button>
        </div>
      );
    }
    if (flows.length === 0) {
      return (
        <>
          <p className="flows-page__intro">
            Playlists that refresh themselves on a schedule. Pick one to start. You can change
            anything later.
          </p>
          <FlowStarters />
        </>
      );
    }
    return (
      <ul className="flows-list" aria-label="Flows">
        {flows.map((flow) => (
          <li key={flow.id}>
            <RouteLink
              to={flowPath(flow.id)}
              className={`flows-list__link${flow.enabled === true ? "" : " is-off"}`}
            >
              <PlaylistArtworkThumb
                sizes="3.25rem"
                artworkUrl={artworkUrlFor(flow.id)}
                name={flow.name}
                className="flows-list__art"
              />
              <span className="flows-list__name">{flow.name}</span>
              <span className="flows-list__recipe">
                {[
                  flow.ownerUsername && flow.ownerUsername !== user?.username
                    ? flow.ownerUsername
                    : null,
                  describeFlowRecipe(flow),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="flows-list__status">{renderStatus(flow)}</span>
            </RouteLink>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="library-page native-library-page playlist-page">
      <header className="native-library-header">
        <div className="native-library-title-row">
          <div className="native-library-title">
            <h1 className="page-title">Flows</h1>
          </div>
          {flows.length > 0 ? (
            <div className="native-library-header-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setNewFlowOpen(true)}
              >
                <Plus aria-hidden="true" />
                New flow
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div className="native-library-content">{renderContent()}</div>
      <NewFlowModal open={newFlowOpen} onClose={() => setNewFlowOpen(false)} />
    </div>
  );
}
