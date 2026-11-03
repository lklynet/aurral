import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "../contexts/ToastContext";
import { downloadTrackToLibrary } from "../utils/api/endpoints/library.ts";
import {
  getApiErrorMessage,
  type buildStaticPlaylistTrackPayload,
} from "../pages/ArtistDetails/utils";

export function useAddTrackToLibrary() {
  const { showError, showSuccess } = useToast();
  const [savingKeys, setSavingKeys] = useState(() => new Set<string>());
  const { mutateAsync: downloadTrack } = useMutation({ mutationFn: downloadTrackToLibrary });

  const addTrackToLibrary = async (
    payload: ReturnType<typeof buildStaticPlaylistTrackPayload>,
    savingKey: string,
  ) => {
    if (!payload.artistName || !payload.trackName) {
      showError("Track details are incomplete");
      return;
    }
    if (!savingKey) return;
    setSavingKeys((current) => new Set(current).add(savingKey));
    try {
      const result = await downloadTrack(payload);
      showSuccess(
        result?.alreadyOwned
          ? `${payload.trackName} is already in your library`
          : result?.queued
            ? `Queued ${payload.trackName} for your library`
            : `Added ${payload.trackName} to your library`,
      );
    } catch (err) {
      showError(getApiErrorMessage(err) || "Failed to add track to library");
    } finally {
      setSavingKeys((current) => {
        const next = new Set(current);
        next.delete(savingKey);
        return next;
      });
    }
  };

  return { savingKeys, addTrackToLibrary };
}
