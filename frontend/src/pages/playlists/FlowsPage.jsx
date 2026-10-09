import { useState } from "react";
import { useNavigate } from "react-router";
import RouteLink from "../../components/RouteLink";
import { useQuery } from "@tanstack/react-query";
import { AudioWaveform, ChevronDown, Sparkles } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import { SkeletonRows, SkeletonStatus } from "../../components/Skeletons";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { createFlow, getFlowTemplates } from "../../utils/api/endpoints/playlists.js";
import { queryKeys } from "../../queryClient.js";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.jsx";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.jsx";
import { getFlowDisplayTrackCount } from "./playlistStats";
import { NEW_FLOW_TEMPLATE, buildFlowFromForm, flowToForm, getNextFlowName } from "./flowPageUtils";
import {
  describeFlowSchedule,
  formatFlowTrackLabel,
  getFlowActivityMessage,
  usePlaylistArtwork,
} from "./playlistPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";
import { flowPath } from "../../navigation/playlistPaths";

export default function FlowsPage() {
  useDocumentTitle("Flows");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, loading, error, fetchStatus, getPlaylistStats, countdownNow, flows } =
    usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [creating, setCreating] = useState(false);

  const templatesQuery = useQuery({
    queryKey: queryKeys.flowTemplates(user?.id),
    queryFn: ({ signal }) => getFlowTemplates({ signal }),
    staleTime: 5 * 60 * 1000,
  });
  const templates = (templatesQuery.data?.templates || []).filter((template) => template.available);

  const handleCreate = async (template = null) => {
    if (creating) return;
    setCreating(true);
    try {
      const payload = template
        ? { templateId: template.id, name: getNextFlowName(flows, template.name) }
        : buildFlowFromForm(
            flowToForm({
              ...NEW_FLOW_TEMPLATE,
              name: getNextFlowName(flows, NEW_FLOW_TEMPLATE.name),
            }),
          );
      const response = await createFlow(payload);
      showSuccess(`Created ${response?.flow?.name || payload.name}`);
      await fetchStatus();
      if (response?.flow?.id) {
        navigate(flowPath(response.flow.id), template ? undefined : { state: { tab: "recipe" } });
      }
    } catch (err) {
      showError(err.response?.data?.message || err.message || "Failed to create flow");
    } finally {
      setCreating(false);
    }
  };

  const renderNewFlowMenu = (triggerClassName) => (
    <LibraryItemMenu
      label="New flow"
      contextMenu={false}
      disabled={creating}
      triggerLabel="New flow"
      triggerClassName={triggerClassName}
      triggerIcon={
        <>
          {creating ? <DotLoader size="sm" label={null} /> : <Sparkles aria-hidden="true" />}
          {creating ? "Creating…" : "New flow"}
          <ChevronDown aria-hidden="true" />
        </>
      }
      menuLabel="Start a flow"
      items={[
        { id: "blank", label: "Blank flow", icon: Sparkles, onSelect: () => handleCreate() },
        ...templates.map((template, index) => ({
          id: template.id,
          label: template.name,
          icon: AudioWaveform,
          separatorBefore: index === 0,
          onSelect: () => handleCreate(template),
        })),
      ]}
    />
  );

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
        <SkeletonStatus label="Loading flows">
          <SkeletonRows count={6} />
        </SkeletonStatus>
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
      return (
        <div className="native-library-state">
          <strong>No flows yet</strong>
          <span>A flow builds a fresh playlist on a schedule from a recipe you choose.</span>
          {renderNewFlowMenu("native-library-state__action")}
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
              <RouteLink to={flowPath(flow.id)} className="flows-list__link">
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
              </RouteLink>
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
          {flows.length > 0 ? (
            <div className="native-library-header-actions">
              {renderNewFlowMenu("btn btn-secondary btn-sm")}
            </div>
          ) : null}
        </div>
      </header>
      <div className="native-library-content">{renderContent()}</div>
    </main>
  );
}
