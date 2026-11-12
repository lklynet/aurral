import { useState } from "react";
import PillToggle from "../../components/PillToggle";
import { useToast } from "../../contexts/ToastContext";
import { parseResponse } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import type { Flow } from "../../utils/playlistStats.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { formatTrackTotal } from "./playlistPageUtils.ts";

export function useFlowEnabled(
  flow: Flow,
  { trackCount = 0, onChanged }: { trackCount?: number; onChanged?: () => unknown } = {},
) {
  const { showSuccess, showError } = useToast();
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [lastRunWhenTurnedOn, setLastRunWhenTurnedOn] = useState<Flow["lastRunAt"] | undefined>();

  const applyEnabled = async (nextEnabled: boolean) => {
    setPendingEnabled(nextEnabled);
    try {
      await parseResponse(
        flowsClient.flows[":flowId"].enabled.$put({
          param: { flowId: encodeURIComponent(flow.id) },
          json: { enabled: nextEnabled },
        }),
      );
      setLastRunWhenTurnedOn(nextEnabled ? flow.lastRunAt : undefined);
      showSuccess(nextEnabled ? `${flow.name} turned on` : `${flow.name} turned off`);
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to update flow"));
    } finally {
      await onChanged?.();
      setPendingEnabled(null);
      setConfirmDisable(false);
    }
  };

  return {
    enabled: pendingEnabled ?? flow.enabled === true,
    pending: pendingEnabled !== null,
    awaitingRun:
      flow.enabled === true &&
      lastRunWhenTurnedOn !== undefined &&
      flow.lastRunAt === lastRunWhenTurnedOn,
    setEnabled: (nextEnabled: boolean) =>
      nextEnabled ? void applyEnabled(true) : setConfirmDisable(true),
    confirmModal: (
      <ConfirmModal
        open={confirmDisable}
        title={`Turn off ${flow.name}?`}
        body={`Removes its ${trackCount > 0 ? formatTrackTotal(trackCount) : "tracks"} and stops refreshes. Turning it back on builds a new mix.`}
        confirmLabel="Turn off"
        busyLabel="Turning off…"
        busy={pendingEnabled === false}
        onCancel={() => setConfirmDisable(false)}
        onConfirm={() => applyEnabled(false)}
      />
    ),
  };
}

export function FlowEnabledSwitch({
  flow,
  trackCount,
  onChanged,
}: {
  flow: Flow;
  trackCount?: number;
  onChanged?: () => unknown;
}) {
  const { enabled, pending, setEnabled, confirmModal } = useFlowEnabled(flow, {
    trackCount,
    onChanged,
  });
  return (
    <>
      <PillToggle
        checked={enabled}
        aria-label="Flow on"
        disabled={pending}
        onChange={(event: { target: { checked: boolean } }) => setEnabled(event.target.checked)}
      />
      {confirmModal}
    </>
  );
}
