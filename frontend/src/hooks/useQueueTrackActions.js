import { useCallback } from "react";
import { ListEnd, ListStart } from "lucide-react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";

export function useQueueTrackActions() {
  const { queueNext, addToQueue } = useAudioQueue();
  const { showSuccess } = useToast();

  return useCallback(
    (track, { source = null, disabled = false } = {}) => {
      if (!track?.src) return [];
      const run = (insert, message) => () => {
        if (insert(track, { source }) === "queued") showSuccess(message);
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
