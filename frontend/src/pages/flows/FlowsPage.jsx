import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { createFlow } from "../../utils/api/endpoints/playlists.js";
import { PlaylistArtworkThumb } from "./flowComponents/PlaylistArtworkThumb.jsx";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.jsx";
import { getFlowDisplayTrackCount } from "./flowStats";
import { NEW_FLOW_TEMPLATE, buildFlowFromForm, flowToForm, getNextFlowName } from "./flowPageUtils";
import {
  describeFlowSchedule,
  formatFlowTrackLabel,
  getFlowActivityMessage,
  usePlaylistArtwork,
} from "./playlistShared";
import { useFlowStatus } from "./useFlowStatus";
import { flowPath } from "../../navigation/playlistPaths";

export default function FlowsPage() {
  useDocumentTitle("Flows");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, loading, error, fetchStatus, getPlaylistStats, countdownNow, flows } =
    useFlowStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [creating, setCreating] = useState(false);
  const canCreate = Object.keys(status?.capabilities?.unavailableSources || {}).length === 0;

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const draft = flowToForm({
        ...NEW_FLOW_TEMPLATE,
        name: getNextFlowName(flows, NEW_FLOW_TEMPLATE.name),
      });
      const response = await createFlow(buildFlowFromForm(draft));
      showSuccess(`Created ${response?.flow?.name || draft.name}`);
      await fetchStatus();
      if (response?.flow?.id) {
        navigate(flowPath(response.flow.id), { state: { tab: "recipe" } });
      }
    } catch (err) {
      showError(err.response?.data?.message || err.message || "Failed to create flow");
    } finally {
      setCreating(false);
    }
  };

  const describeFlow = (flow) => {
    const stats = getPlaylistStats(flow.id);
    const parts = [formatFlowTrackLabel(getFlowDisplayTrackCount(flow, stats), stats)];
    if (flow.ownerUsername && (user?.role === "admin" || flow.ownerUsername !== user?.username)) {
      parts.unshift(flow.ownerUsername);
    }
    const schedule = describeFlowSchedule(flow, countdownNow);
    if (schedule) parts.push(schedule);
    return parts.join(" · ");
  };

  const renderContent = () => {
    if (loading && !status) {
      return (
        <div className="native-library-state" role="status">
          <DotLoader size="xl" label={null} />
          <span>Loading flows…</span>
        </div>
      );
    }
    if (error && !status) {
      return (
        <div className="native-library-state" role="alert">
          <strong>Flows unavailable</strong>
          <span>Aurral could not load your flows.</span>
          <button type="button" className="native-library-state__action" onClick={fetchStatus}>
            Retry
          </button>
        </div>
      );
    }
    if (flows.length === 0) {
      return canCreate ? (
        <div className="native-library-state">
          <strong>No flows yet</strong>
          <span>A flow builds a fresh playlist on a schedule from a recipe you choose.</span>
          <button
            type="button"
            className="native-library-state__action"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? <DotLoader size="sm" label={null} /> : <Sparkles aria-hidden="true" />}
            {creating ? "Creating…" : "New flow"}
          </button>
        </div>
      ) : (
        <div className="native-library-state">
          <strong>Flows need a Last.fm API key</strong>
          <span>Add one in Connect settings to build flows.</span>
          <Link to="/settings/connect" className="native-library-state__action">
            Open Connect settings
          </Link>
        </div>
      );
    }
    return (
      <ul className="flows-list" aria-label="Flows">
        {flows.map((flow) => {
          const activity = getFlowActivityMessage({
            flow,
            status,
            stats: getPlaylistStats(flow.id),
          });
          return (
            <li key={flow.id} className="flows-list__row">
              <Link to={flowPath(flow.id)} className="flows-list__link">
                <PlaylistArtworkThumb
                  artworkUrl={artworkUrlFor(flow.id)}
                  name={flow.name}
                  className="flows-list__art"
                />
                <span className="flows-list__copy">
                  <span className="flows-list__name">{flow.name}</span>
                  <span className="flows-list__meta">
                    {activity ? (
                      <>
                        <DotLoader size="xs" label={null} />
                        {activity}
                      </>
                    ) : (
                      describeFlow(flow)
                    )}
                  </span>
                </span>
              </Link>
              <FlowEnabledSwitch flow={flow} onChanged={fetchStatus} />
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <main className="library-page native-library-page playlist-page">
      <header className="native-library-header">
        <div className="native-library-title-row">
          <div className="native-library-title">
            <h1 className="page-title">Flows</h1>
          </div>
          {canCreate && flows.length > 0 ? (
            <div className="native-library-header-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? <DotLoader size="sm" label={null} /> : <Sparkles aria-hidden="true" />}
                {creating ? "Creating…" : "New flow"}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div className="native-library-content">{renderContent()}</div>
    </main>
  );
}
