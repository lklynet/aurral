import { useState } from "react";
import PillToggle from "../../components/PillToggle";
import { useToast } from "../../contexts/ToastContext";
import { setFlowEnabled } from "../../utils/api/endpoints/playlists.js";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";

export function FlowEnabledSwitch({ flow, onChanged }) {
  const { showSuccess, showError } = useToast();
  const [pendingEnabled, setPendingEnabled] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const enabled = pendingEnabled ?? flow.enabled === true;

  const applyEnabled = async (nextEnabled) => {
    setPendingEnabled(nextEnabled);
    try {
      await setFlowEnabled(flow.id, nextEnabled);
      showSuccess(nextEnabled ? `${flow.name} turned on` : `${flow.name} turned off`);
      await onChanged?.();
    } catch (err) {
      showError(err.response?.data?.message || err.message || "Failed to update flow");
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
        onChange={(event) => {
          if (event.target.checked) void applyEnabled(true);
          else setConfirmDisable(true);
        }}
      />
      <ConfirmModal
        open={confirmDisable}
        title={`Turn off ${flow.name}?`}
        body="It stops updating and its current songs are removed. Turning it back on picks a fresh set."
        confirmLabel="Turn off"
        busyLabel="Turning off…"
        busy={pendingEnabled === false}
        onCancel={() => setConfirmDisable(false)}
        onConfirm={() => applyEnabled(false)}
      />
    </>
  );
}
