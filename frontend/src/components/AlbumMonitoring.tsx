import { useState } from "react";
import { parseResponse } from "hono/client";
import { Eye, EyeOff } from "./icons";

import { useToast } from "../contexts/ToastContext";
import { getApiErrorMessage } from "../utils/api/errors.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { libraryAlbumsClient } from "../utils/api/clients/libraryAlbums.ts";
import { setAlbumMonitoring, type MonitoringResult } from "../utils/api/endpoints/library.ts";
import {
  describeAlbumMonitoringResult,
  getAlbumMonitoredState,
  getMonitoringMenuAction,
  shouldConfirmUnmonitor,
  type AlbumMonitoredRef,
} from "../utils/monitoring.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";

type AlbumId = string | number;

export interface LibraryAlbumRef extends AlbumMonitoredRef {
  id: AlbumId;
  title?: string;
}

interface AlbumMonitoringOptions {
  album: LibraryAlbumRef | null;
  enabled: boolean;
  canChange: boolean;
  hasMissingTracks: boolean;
  onChanged?: (albumId: AlbumId, result: MonitoringResult) => void;
}

export function useAlbumMonitoring({
  album,
  enabled,
  canChange,
  hasMissingTracks,
  onChanged,
}: AlbumMonitoringOptions) {
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const [confirmingId, setConfirmingId] = useState<AlbumId | null>(null);
  const [override, setOverride] = useState<{ albumId: AlbumId; monitored: boolean } | null>(null);
  const savedMonitored = enabled ? getAlbumMonitoredState(album) : null;
  const monitored =
    savedMonitored !== null && override?.albumId === album?.id
      ? override!.monitored
      : savedMonitored;

  if (monitored === null) return { monitored: null, menuItem: null, dialog: null };
  if (!canChange) return { monitored, menuItem: null, dialog: null };

  const currentAlbum = album!;
  const albumId = currentAlbum.id;
  const apply = async (nextMonitored: boolean) => {
    if (pending) return;
    setPending(true);
    setConfirmingId(null);
    setOverride({ albumId, monitored: nextMonitored });
    try {
      const result = await setAlbumMonitoring(albumId, nextMonitored);
      const { message, warning } = describeAlbumMonitoringResult(result);
      (warning ? showError : showSuccess)(message);
      onChanged?.(albumId, result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.albumStatus(albumId) });
    } catch (error) {
      showError(
        `Could not ${nextMonitored ? "monitor" : "stop monitoring"} ${currentAlbum.title || "this album"}. Nothing changed. ${getApiErrorMessage(error, "Try again.")}`,
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
        queryKey: queryKeys.albumStatus(albumId),
        queryFn: ({ signal }) =>
          parseResponse(
            libraryAlbumsClient.albums[":albumId"].status.$get(
              { param: { albumId: encodeURIComponent(albumId) } },
              { init: { signal } },
            ),
          ),
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
        body="Stops searches and upgrades for this album, skips it in artist downloads, and cancels unfinished downloads. Library tracks stay."
        confirmLabel="Stop monitoring"
        busyLabel="Stopping"
        busy={pending}
        onCancel={() => setConfirmingId(null)}
        onConfirm={() => apply(false)}
      />
    ),
  };
}
