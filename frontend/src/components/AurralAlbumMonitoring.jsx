import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";
import { getAurralAlbumStatus, setAurralAlbumMonitoring } from "../utils/api/endpoints/library.js";
import {
  describeAlbumMonitoringResult,
  getAlbumMonitoredState,
  getMonitoringMenuAction,
  shouldConfirmUnmonitor,
} from "../utils/aurralMonitoring.js";
import { ConfirmModal } from "./ConfirmModal.jsx";

const errorMessage = (error) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  "Try again.";

export function useAurralAlbumMonitoring({ album, enabled, canChange, hasMissingTracks, onChanged }) {
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);
  const [override, setOverride] = useState(null);
  const savedMonitored = enabled ? getAlbumMonitoredState(album) : null;
  const monitored =
    savedMonitored !== null && override?.albumId === album?.id ? override.monitored : savedMonitored;

  if (monitored === null) return { monitored: null, menuItem: null, dialog: null };
  if (!canChange) return { monitored, menuItem: null, dialog: null };

  const albumId = album.id;
  const apply = async (nextMonitored) => {
    if (pending) return;
    setPending(true);
    setConfirmingId(null);
    setOverride({ albumId, monitored: nextMonitored });
    try {
      const result = await setAurralAlbumMonitoring(albumId, nextMonitored);
      const { message, warning } = describeAlbumMonitoringResult(result);
      (warning ? showError : showSuccess)(message);
      onChanged?.(albumId, result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aurralAlbumStatus(albumId) });
    } catch (error) {
      showError(
        `Could not ${nextMonitored ? "monitor" : "stop monitoring"} ${album.title || "this album"}. Nothing changed. ${errorMessage(error)}`,
      );
    } finally {
      setOverride(null);
      setPending(false);
    }
  };

  const toggle = async () => {
    if (!monitored) return apply(true);
    const status = await queryClient
      .fetchQuery({
        queryKey: queryKeys.aurralAlbumStatus(albumId),
        queryFn: ({ signal }) => getAurralAlbumStatus(albumId, { signal }),
      })
      .catch(() => null);
    if (shouldConfirmUnmonitor(status?.status)) setConfirmingId(albumId);
    else apply(false);
  };

  const action = getMonitoringMenuAction({ monitored, hasMissing: hasMissingTracks });

  return {
    monitored,
    menuItem: action && {
      id: "monitoring",
      label: monitored ? "Stop monitoring album" : "Monitor album",
      icon: monitored ? EyeOff : Eye,
      separatorBefore: true,
      disabled: pending,
      closeBeforeSelect: true,
      onSelect: toggle,
    },
    dialog: (
      <ConfirmModal
        open={confirmingId === albumId}
        title="Stop monitoring this album?"
        body="Aurral will stop searching for and upgrading every track on this album, and skip it when it downloads releases for this artist. Unfinished downloads will be cancelled. Tracks already in your library are kept."
        confirmLabel="Stop monitoring"
        busyLabel="Stopping"
        busy={pending}
        onCancel={() => setConfirmingId(null)}
        onConfirm={() => apply(false)}
      />
    ),
  };
}
