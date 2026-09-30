import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";
import { getAurralAlbumStatus, setAurralAlbumMonitoring } from "../utils/api/endpoints/library.js";
import {
  describeAlbumMonitoringResult,
  getAlbumMonitoredState,
  shouldConfirmUnmonitor,
} from "../utils/aurralMonitoring.js";
import { ConfirmModal } from "../pages/flows/flowComponents/ConfirmModal.jsx";

const errorMessage = (error) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  "Could not update album monitoring";

export function useAurralAlbumMonitoring({ album, enabled, onChanged }) {
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const monitored = enabled ? getAlbumMonitoredState(album) : null;

  if (monitored === null) return { monitored: null, menuItem: null, dialog: null };

  const apply = async (nextMonitored) => {
    setPending(true);
    try {
      const result = await setAurralAlbumMonitoring(album.id, nextMonitored);
      const { message, warning } = describeAlbumMonitoringResult(result);
      (warning ? showError : showSuccess)(message);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aurralAlbumStatus(album.id) });
      onChanged?.(result);
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setPending(false);
      setConfirming(false);
    }
  };

  const toggle = async () => {
    if (!monitored) return apply(true);
    const status = await queryClient
      .fetchQuery({
        queryKey: queryKeys.aurralAlbumStatus(album.id),
        queryFn: ({ signal }) => getAurralAlbumStatus(album.id, { signal }),
      })
      .catch(() => null);
    if (shouldConfirmUnmonitor(status?.status)) setConfirming(true);
    else apply(false);
  };

  return {
    monitored,
    menuItem: {
      id: "monitoring",
      label: monitored ? "Stop monitoring album" : "Monitor album",
      icon: monitored ? EyeOff : Eye,
      separatorBefore: true,
      disabled: pending,
      onSelect: toggle,
    },
    dialog: (
      <ConfirmModal
        open={confirming}
        title="Stop monitoring this album?"
        body="Aurral will skip this album when it downloads releases for this artist, and unfinished downloads will be cancelled. Tracks already in your library are kept."
        confirmLabel="Stop monitoring"
        busyLabel="Stopping"
        busy={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => apply(false)}
      />
    ),
  };
}
