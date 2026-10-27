import { useState } from "react";
import { Eye, EyeOff, Lock, LockOpen } from "./icons";

import { useToast } from "../contexts/ToastContext";
import { getApiErrorMessage } from "../pages/onboardingUtils.tsx";
import {
  setAurralTrackKeepFile,
  setAurralTrackMonitoring,
  type AurralMonitoringResult,
} from "../utils/api/endpoints/library.ts";
import {
  describeKeepFileResult,
  describeTrackMonitoringResult,
  getMonitoringMenuAction,
} from "../utils/aurralMonitoring.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";

type AurralTrackId = number | string;

interface AurralTrackRef {
  id: AurralTrackId;
  title?: string | null;
  trackName?: string | null;
  monitored?: boolean;
  keepFile?: boolean;
}

interface TrackKeepFileResult {
  keepFile?: boolean;
}

interface TrackMenuOptions {
  aurral?: boolean;
  hasFile?: boolean;
  downloadPending?: boolean;
}

const trackTitle = (track: AurralTrackRef | null | undefined) =>
  track?.title || track?.trackName || "this track";

interface AurralTrackMonitoringOptions {
  canChange: boolean;
  onChanged?: (trackId: AurralTrackId, result: AurralMonitoringResult) => void | Promise<void>;
  onKeepFileChanged?: (trackId: AurralTrackId, result: TrackKeepFileResult) => void | Promise<void>;
}

export function useAurralTrackMonitoring({
  canChange,
  onChanged,
  onKeepFileChanged,
}: AurralTrackMonitoringOptions) {
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState<{ id: AurralTrackId; monitored: boolean } | null>(null);
  const [keepPending, setKeepPending] = useState<{ id: AurralTrackId; keepFile: boolean } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<AurralTrackRef | null>(null);

  const isKept = (track: AurralTrackRef | null | undefined) =>
    keepPending && String(keepPending.id) === String(track?.id)
      ? keepPending.keepFile
      : track?.keepFile === true;

  const setKeepFile = async (track: AurralTrackRef, keepFile: boolean) => {
    if (keepPending) return;
    setKeepPending({ id: track.id, keepFile });
    try {
      const result = await setAurralTrackKeepFile(track.id, keepFile);
      const { message, warning } = describeKeepFileResult(result, trackTitle(track));
      (warning ? showError : showSuccess)(message);
      await onKeepFileChanged?.(track.id, result);
    } catch (error) {
      showError(
        `Could not ${keepFile ? "keep" : "allow upgrades for"} ${trackTitle(track)}. Nothing changed. ${getApiErrorMessage(error, "Try again.")}`,
      );
    } finally {
      setKeepPending(null);
    }
  };

  const isMonitored = (track: AurralTrackRef | null | undefined) =>
    pending && String(pending.id) === String(track?.id)
      ? pending.monitored
      : track?.monitored !== false;

  const apply = async (track: AurralTrackRef, nextMonitored: boolean) => {
    if (pending) return;
    setPending({ id: track.id, monitored: nextMonitored });
    setConfirming(null);
    try {
      const result = await setAurralTrackMonitoring(track.id, nextMonitored);
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
    track: AurralTrackRef,
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

  const getKeepFileItem = (
    track: AurralTrackRef,
    { aurral = false, hasFile = false }: TrackMenuOptions = {},
  ) => {
    if (!aurral || !hasFile || !canChange || !Number.isInteger(Number(track?.id))) return null;
    const kept = isKept(track);
    return {
      id: "keep-file",
      label: kept ? "Allow upgrades" : "Keep this file",
      icon: kept ? LockOpen : Lock,
      disabled: keepPending !== null,
      closeBeforeSelect: true,
      onSelect: () => setKeepFile(track, !kept),
    };
  };

  return {
    getMenuItem,
    getKeepFileItem,
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
        onConfirm={() => apply(confirming as AurralTrackRef, false)}
      />
    ),
  };
}
