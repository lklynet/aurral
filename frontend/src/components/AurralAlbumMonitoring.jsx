import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import PillToggle from "./PillToggle";
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

export function AurralAlbumMonitoring({ album, onChanged }) {
  const { showSuccess, showError } = useToast();
  const toggleId = useId();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.aurralAlbumStatus(album.id),
    queryFn: ({ signal }) => getAurralAlbumStatus(album.id, { signal }),
    staleTime: 0,
  });
  const monitored = getAlbumMonitoredState(album);

  if (monitored === null) return null;

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

  const handleChange = () => {
    if (monitored && shouldConfirmUnmonitor(statusQuery.data?.status)) {
      setConfirming(true);
      return;
    }
    apply(!monitored);
  };

  return (
    <div className="native-library-album-monitoring">
      <label htmlFor={toggleId} className="native-library-album-monitoring__label">
        Monitored
      </label>
      <PillToggle
        id={toggleId}
        checked={monitored}
        onChange={handleChange}
        disabled={pending}
        aria-label="Monitored"
      />
      <span className="native-library-album-monitoring__state">{monitored ? "On" : "Off"}</span>
      <ConfirmModal
        open={confirming}
        title="Stop monitoring this album?"
        body="Unmonitoring cancels unfinished downloads. Tracks already in your library are kept."
        confirmLabel="Unmonitor"
        busyLabel="Unmonitoring"
        busy={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => apply(false)}
      />
    </div>
  );
}
