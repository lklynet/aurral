import { useState } from "react";
import PillToggle from "../../components/PillToggle";
import { useToast } from "../../contexts/ToastContext";
import { parseResponse } from "hono/client";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import type { Flow } from "./playlistStats.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getApiErrorText } from "../onboardingUtils.tsx";

export function FlowEnabledSwitch({ flow, onChanged }: { flow: Flow; onChanged?: () => unknown }) {
  const { showSuccess, showError } = useToast();
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const enabled = pendingEnabled ?? flow.enabled === true;

  const applyEnabled = async (nextEnabled: boolean) => {
    setPendingEnabled(nextEnabled);
    try {
      await parseResponse(
        flowsClient.flows[":flowId"].enabled.$put({
          param: { flowId: encodeURIComponent(flow.id) },
          json: { enabled: nextEnabled },
        }),
      );
      showSuccess(nextEnabled ? `${flow.name} turned on` : `${flow.name} turned off`);
      await onChanged?.();
    } catch (err) {
      showError(
        getApiErrorText(err, "message") || asApiError(err)?.message || "Failed to update flow",
      );
    } finally {
      setPendingEnabled(null);
      setConfirmDisable(false);
    }
  };

  return (
    <>
      <PillToggle
        checked={enabled}
        aria-label={`${flow.name || "Flow"} ${enabled ? "on" : "off"}`}
        disabled={pendingEnabled !== null}
        onChange={(event: { target: { checked: boolean } }) => {
          if (event.target.checked) void applyEnabled(true);
          else setConfirmDisable(true);
        }}
      />
      <ConfirmModal
        open={confirmDisable}
        title={`Turn off ${flow.name}?`}
        body="Removes its current songs and stops updates. Turning it on generates a new set."
        confirmLabel="Turn off"
        busyLabel="Turning off…"
        busy={pendingEnabled === false}
        onCancel={() => setConfirmDisable(false)}
        onConfirm={() => applyEnabled(false)}
      />
    </>
  );
}
