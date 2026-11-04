import { useCallback } from "react";
import { ListEnd, ListStart, Radio } from "../components/icons";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import {
  normalizeQueueTrack,
  radioSeedFor,
  type QueueTrackInput,
  type RadioSeed,
} from "../utils/audioQueue";
import type { PlaybackSource } from "./useAlbumTrackListToolbar";

export function useStartRadio() {
  const { startRadio } = useAudioQueue();
  const { showError } = useToast();
  return useCallback(
    (seed: RadioSeed, options: { label: string; first?: QueueTrackInput | null }) =>
      startRadio(seed, options)
        .then((started) => {
          if (!started) showError("No similar music in your Library yet.");
        })
        .catch(() => showError("Couldn't start radio. Try again.")),
    [showError, startRadio],
  );
}

export function useQueueTrackActions() {
  const { queueNext, addToQueue } = useAudioQueue();
  const { showSuccess } = useToast();
  const startRadio = useStartRadio();

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
      const tracks = (Array.isArray(track) ? track : [track!]).map((entry) =>
        normalizeQueueTrack(entry),
      );
      const [first] = tracks;
      const single = !Array.isArray(track) && first && !first.isPreview ? track! : null;
      const label =
        (Array.isArray(track) ? first?.album || first?.artist : first?.title) || "Track";
      const radio = () => startRadio(radioSeedFor(tracks), { label, first: single });
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
        {
          id: "radio",
          label: "Start radio",
          icon: Radio,
          disabled,
          onSelect: radio,
        },
      ];
    },
    [addToQueue, queueNext, showSuccess, startRadio],
  );
}
