import { useCallback } from "react";
import { ListEnd, ListStart } from "../components/icons";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import type { PlaybackSource } from "./useAlbumTrackListToolbar";

interface QueueTrackInput {
  src?: string | null;
}

export function useQueueTrackActions() {
  const { queueNext, addToQueue } = useAudioQueue();
  const { showSuccess } = useToast();

  return useCallback(
    (
      track: QueueTrackInput | QueueTrackInput[] | null | undefined,
      {
        source = null,
        disabled = false,
      }: { source?: PlaybackSource | null; disabled?: boolean } = {},
    ) => {
      if (Array.isArray(track) ? !track.some((entry) => entry?.src) : !track?.src) return [];
      const run =
        (
          insert: (
            track: QueueTrackInput | QueueTrackInput[],
            options: { source: PlaybackSource | null },
          ) => unknown,
          message: string,
        ) =>
        () => {
          if (insert(track!, { source }) === "queued") showSuccess(message);
        };
      return [
        {
          id: "queue-next",
          label: "Play next",
          icon: ListStart,
          disabled,
          onSelect: run(queueNext, "Playing next"),
        },
        {
          id: "queue-add",
          label: "Add to queue",
          icon: ListEnd,
          disabled,
          onSelect: run(addToQueue, "Added to queue"),
        },
      ];
    },
    [addToQueue, queueNext, showSuccess],
  );
}
