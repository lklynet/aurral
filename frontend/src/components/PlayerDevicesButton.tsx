import { useAudioQueue } from "../contexts/audioQueueContext";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { formatPlaybackTime } from "../utils/playbackTime.ts";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { Play, Speaker } from "./icons";

export default function PlayerDevicesButton({ className }: { className: string }) {
  const { queueElsewhere, pickUpQueueElsewhere } = useAudioQueue();
  if (!queueElsewhere) return null;
  const label = `Pick up from ${queueElsewhere.device}`;
  return (
    <LibraryItemMenu
      label={label}
      menuLabel="Devices"
      triggerLabel={label}
      triggerIcon={<Speaker aria-hidden="true" />}
      triggerClassName={`${className} player-devices`}
      contextMenu={false}
      items={[
        {
          id: "pick-up",
          label,
          description: [
            queueElsewhere.title,
            formatPlaybackTime(queueElsewhere.position),
            formatRelativeTime(new Date(Math.min(queueElsewhere.savedAt, Date.now()))),
          ].join(" · "),
          icon: Play,
          onSelect: pickUpQueueElsewhere,
        },
      ]}
    />
  );
}
