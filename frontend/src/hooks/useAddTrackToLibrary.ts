import { useMemo } from "react";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { useToast } from "../contexts/ToastContext";
import { downloadTrackToLibrary } from "../utils/api/endpoints/library.ts";
import {
  getApiErrorMessage,
  type buildStaticPlaylistTrackPayload,
} from "../pages/ArtistDetails/utils";

type AddTrackRequest = {
  payload: ReturnType<typeof buildStaticPlaylistTrackPayload>;
  savingKey: string;
};
const ADD_TRACK_MUTATION = ["library", "add-track"] as const;
const sending = new Set<string>();

export function useAddTrackToLibrary() {
  const { showError, showSuccess } = useToast();
  const { mutateAsync: downloadTrack } = useMutation({
    mutationKey: ADD_TRACK_MUTATION,
    mutationFn: ({ payload }: AddTrackRequest) => downloadTrackToLibrary(payload),
  });
  const pendingKeys = useMutationState({
    filters: { mutationKey: ADD_TRACK_MUTATION, status: "pending" },
    select: (mutation) => (mutation.state.variables as AddTrackRequest | undefined)?.savingKey,
  });
  const savingKeys = useMemo(
    () => new Set(pendingKeys.filter((key): key is string => Boolean(key))),
    [pendingKeys],
  );

  const addTrackToLibrary = async (payload: AddTrackRequest["payload"], savingKey: string) => {
    if (!payload.artistName || !payload.trackName) {
      showError("Track details are incomplete");
      return;
    }
    if (!savingKey || sending.has(savingKey)) return;
    sending.add(savingKey);
    try {
      const result = await downloadTrack({ payload, savingKey });
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
      sending.delete(savingKey);
    }
  };

  return { savingKeys, addTrackToLibrary };
}
