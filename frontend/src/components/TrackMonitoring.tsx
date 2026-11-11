import { useState } from "react";
import { Eye, EyeOff } from "./icons";

import { useToast } from "../contexts/ToastContext";
import { getApiErrorMessage } from "../utils/api/errors.ts";
import { setTrackMonitoring, type MonitoringResult } from "../utils/api/endpoints/library.ts";
import { describeTrackMonitoringResult, getMonitoringMenuAction } from "../utils/monitoring.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";

type TrackId = number | string;

interface TrackRef {
  id: TrackId;
  title?: string | null;
  trackName?: string | null;
  monitored?: boolean;
}

interface TrackMenuOptions {
  aurral?: boolean;
  hasFile?: boolean;
  downloadPending?: boolean;
}

const trackTitle = (track: TrackRef | null | undefined) =>
  track?.title || track?.trackName || "this track";

interface TrackMonitoringOptions {
  canChange: boolean;
  onChanged?: (trackId: TrackId, result: MonitoringResult) => void | Promise<void>;
}

export function useTrackMonitoring({ canChange, onChanged }: TrackMonitoringOptions) {
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState<{ id: TrackId; monitored: boolean } | null>(null);
  const [confirming, setConfirming] = useState<TrackRef | null>(null);

  const isMonitored = (track: TrackRef | null | undefined) =>
    pending && String(pending.id) === String(track?.id)
      ? pending.monitored
      : track?.monitored !== false;

  const apply = async (track: TrackRef, nextMonitored: boolean) => {
    if (pending) return;
    setPending({ id: track.id, monitored: nextMonitored });
    setConfirming(null);
    try {
      const result = await setTrackMonitoring(track.id, nextMonitored);
      const { message, warning } = describeTrackMonitoringResult(result);
      (warning ? showError : showSuccess)(message);
      await onChanged?.(track.id, result);
    } catch (error) {
      showError(
        `Could not ${nextMonitored ? "monitor" : "stop monitoring"} ${trackTitle(track)}. Nothing changed. ${getApiErrorMessage(error, "Try again.")}`,
      );
    } finally {
      setPending(null);
    }
  };

  const getMenuItem = (
    track: TrackRef,
    { aurral = false, hasFile = false, downloadPending = false }: TrackMenuOptions = {},
  ) => {
    if (!aurral || !canChange || !Number.isInteger(Number(track?.id))) return null;
    const monitored = isMonitored(track);
    if (!getMonitoringMenuAction({ monitored, hasMissing: !hasFile })) return null;
    return {
      id: "monitoring",
      label: monitored ? "Stop monitoring track" : "Monitor track",
      icon: monitored ? EyeOff : Eye,
      separatorBefore: true,
      disabled: pending !== null,
      closeBeforeSelect: true,
      onSelect: () => {
        if (monitored && downloadPending) setConfirming(track);
        else return apply(track, !monitored);
      },
    };
  };

  return {
    getMenuItem,
    isMonitored,
    dialog: (
      <ConfirmModal
        open={confirming !== null}
        title="Stop monitoring this track?"
        body="Stops searches and upgrades for this track and cancels its unfinished download. The Library file stays."
        confirmLabel="Stop monitoring"
        busyLabel="Stopping"
        busy={pending !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => apply(confirming as TrackRef, false)}
      />
    ),
  };
}
