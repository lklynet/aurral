import { useState } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { formatPlaybackTime } from "../utils/playbackTime.ts";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { Play, Speaker } from "./icons";

export default function PlayerDevicesButton({
  className,
  tooltipPlacement,
}: {
  className: string;
  tooltipPlacement?: "top";
}) {
  const { queueElsewhere, pickUpQueueElsewhere } = useAudioQueue();
  const [now, setNow] = useState(Date.now);
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
      tooltipPlacement={tooltipPlacement}
      onMenuOpen={() => setNow(Date.now())}
      items={[
        {
          id: "pick-up",
          label,
          description: [
            queueElsewhere.title,
            formatPlaybackTime(queueElsewhere.position),
            formatRelativeTime(new Date(Math.min(queueElsewhere.savedAt, now)), {
              now: new Date(now),
            }),
          ].join(" · "),
          icon: Play,
          onSelect: pickUpQueueElsewhere,
        },
      ]}
    />
  );
}
