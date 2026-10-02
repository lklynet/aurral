import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { useToast } from "../contexts/ToastContext";
import { setAurralTrackMonitoring } from "../utils/api/endpoints/library.js";
import { describeTrackMonitoringResult } from "../utils/aurralMonitoring.js";
import { ConfirmModal } from "../pages/flows/flowComponents/ConfirmModal.jsx";

const errorMessage = (error) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  "Could not update track monitoring";

export function useAurralTrackMonitoring({ albumMonitored, canChange, onChanged }) {
  const { showSuccess, showError } = useToast();
  const [pendingId, setPendingId] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const apply = async (track, nextMonitored) => {
    setPendingId(track.id);
    try {
      const result = await setAurralTrackMonitoring(track.id, nextMonitored);
      const { message, warning } = describeTrackMonitoringResult(result);
      (warning ? showError : showSuccess)(message);
      await onChanged?.(track.id, result);
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setPendingId(null);
      setConfirming(null);
    }
  };

  const getMenuItem = (track, { downloadPending = false } = {}) => {
    if (albumMonitored == null || !canChange || !Number.isInteger(Number(track?.id))) return null;
    if (!albumMonitored) {
      return {
        id: "monitoring",
        label: "Album isn't monitored",
        icon: EyeOff,
        separatorBefore: true,
        disabled: true,
      };
    }
    const monitored = track.monitored !== false;
    return {
      id: "monitoring",
      label: monitored ? "Stop monitoring track" : "Monitor track",
      icon: monitored ? EyeOff : Eye,
      separatorBefore: true,
      disabled: pendingId !== null,
      closeBeforeSelect: true,
      onSelect: () => {
        if (monitored && downloadPending) setConfirming(track);
        else return apply(track, !monitored);
      },
    };
  };

  return {
    getMenuItem,
    dialog: (
      <ConfirmModal
        open={confirming !== null}
        title="Stop monitoring this track?"
        body="Aurral will stop searching for and upgrading this track, and its unfinished download will be cancelled. A file already in your library is kept."
        confirmLabel="Stop monitoring"
        busyLabel="Stopping"
        busy={pendingId !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => apply(confirming, false)}
      />
    ),
  };
}
