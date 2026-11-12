import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { Plus } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { SkeletonShape, SkeletonStatus, SkeletonText } from "../../components/Skeletons";
import { ModalShell } from "../../components/PlaylistModals.tsx";
import { PlaylistArtworkThumb } from "../../components/PlaylistArtworkThumb.tsx";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { queryKeys } from "../../queryClient.ts";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { flowPath } from "../../navigation/playlistPaths";
import { getNextFlowName, newBlankFlow } from "./flowPageUtils";
import { usePlaylistStatus } from "./usePlaylistStatus";

type FlowTemplate = InferResponseType<
  (typeof flowsClient)["flow-templates"]["$get"],
  200
>["templates"][number];

const CUSTOM = "custom";

export function FlowStarters({ onCreated }: { onCreated?: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { flows, fetchStatus } = usePlaylistStatus();
  const [creating, setCreating] = useState<string | null>(null);
  const templatesQuery = useQuery({
    queryKey: queryKeys.flowTemplates(user?.id),
    queryFn: ({ signal }) =>
      parseResponse(flowsClient["flow-templates"].$get(undefined, { init: { signal } })),
    staleTime: 5 * 60 * 1000,
  });
  const templates = [...(templatesQuery.data?.templates ?? [])].sort(
    (a, b) => Number(b.available) - Number(a.available),
  );

  const create = async (template: FlowTemplate | null) => {
    if (creating) return;
    setCreating(template?.id ?? CUSTOM);
    try {
      const { flow } = await parseResponse(
        flowsClient.flows.$post({
          json: template
            ? { templateId: template.id, name: getNextFlowName(flows, template.name) }
            : newBlankFlow(flows),
        }),
      );
      if (template) {
        await parseResponse(
          flowsClient.flows[":flowId"].enabled.$put({
            param: { flowId: encodeURIComponent(flow.id) },
            json: { enabled: true },
          }),
        ).catch((err: unknown) =>
          showError(getApiErrorMessage(err, `Created ${flow.name}, but couldn't turn it on`)),
        );
      }
      showSuccess(`Created ${flow.name}`);
      await fetchStatus();
      onCreated?.();
      navigate(flowPath(flow.id), template ? undefined : { state: { edit: true } });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to create flow"));
    } finally {
      setCreating(null);
    }
  };

  if (templatesQuery.isPending) {
    return (
      <SkeletonStatus label="Loading starters">
        <ul className="flow-starters">
          {["9em", "7em", "8em", "10em"].map((width) => (
            <li key={width} className="flow-starters__item">
              <SkeletonShape className="flow-page__artwork flow-starters__art" />
              <span className="flow-starters__copy">
                <SkeletonText width={width} />
                <SkeletonText width="14em" />
              </span>
            </li>
          ))}
        </ul>
      </SkeletonStatus>
    );
  }

  const option = (
    id: string,
    name: string,
    description: string,
    art: ReactNode,
    onSelect: (() => void) | null,
  ) => (
    <li key={id}>
      <button
        type="button"
        className="flow-starters__item"
        disabled={onSelect === null || creating !== null}
        aria-busy={creating === id}
        onClick={onSelect ?? undefined}
      >
        {art}
        <span className="flow-starters__copy">
          <span className="flow-starters__name">{name}</span>
          <span className="flow-starters__description">{description}</span>
        </span>
        {creating === id ? <DotLoader size="sm" label={null} /> : null}
      </button>
    </li>
  );

  return (
    <ul className="flow-starters" aria-label="Start a flow">
      {templates.map((template) =>
        option(
          template.id,
          template.name,
          template.available
            ? template.description
            : "Needs listening history. Play some music first.",
          <PlaylistArtworkThumb
            sizes="3.5rem"
            name={template.name}
            className="flow-starters__art"
          />,
          template.available ? () => create(template) : null,
        ),
      )}
      {option(
        CUSTOM,
        "Custom",
        "Choose your own sources, schedule, and filters",
        <span className="flow-page__artwork flow-starters__art flow-starters__plus">
          <Plus aria-hidden="true" />
        </span>,
        () => create(null),
      )}
    </ul>
  );
}

export function NewFlowModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalShell open={open} title="New flow" onClose={onClose} className="playlist-modal--new-flow">
      <FlowStarters onCreated={onClose} />
    </ModalShell>
  );
}
