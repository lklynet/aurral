import { useState } from "react";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { formatPlaybackTime } from "../utils/playbackTime.ts";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { Devices, Play } from "./icons";

export default function PlayerDevicesButton({ className }: { className: string }) {
  const { queueElsewhere, pickUpQueueElsewhere } = useAudioQueue();
  const [now, setNow] = useState(Date.now);
  if (!queueElsewhere) return null;
  const label = `Pick up from ${queueElsewhere.device}`;
  return (
    <LibraryItemMenu
      label={label}
      menuLabel="Devices"
      triggerLabel={label}
      triggerIcon={<Devices aria-hidden="true" />}
      triggerClassName={`${className} player-devices`}
      contextMenu={false}
      tooltipPlacement="top"
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
          closeBeforeSelect: true,
          onSelect: () => {
            const next = document.activeElement?.closest(
              ".native-library-item-menu",
            )?.nextElementSibling;
            const target = next?.matches("button") ? next : next?.querySelector("button");
            pickUpQueueElsewhere();
            if (target instanceof HTMLElement) {
              requestAnimationFrame(() => target.focus({ preventScroll: true }));
            }
          },
        },
      ]}
    />
  );
}
