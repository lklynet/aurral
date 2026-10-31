import { useId, useState } from "react";
import ActivityRequestRow, { type ActivityRequestRowProps } from "./ActivityRequestRow";
import type { AlbumActivityRequest } from "./activityListUtils";

type ActivityAlbumRowProps = Omit<
  ActivityRequestRowProps,
  "request" | "onToggle" | "expanded" | "tracksId"
> & {
  request: AlbumActivityRequest;
};

export default function ActivityAlbumRow({ request, ...actions }: ActivityAlbumRowProps) {
  const [expanded, setExpanded] = useState(false);
  const tracksId = useId();
  return (
    <section className="activity-album" aria-label={`${request.albumName}, ${request.artistName}`}>
      <ActivityRequestRow
        request={request}
        {...actions}
        onToggle={() => setExpanded((value) => !value)}
        expanded={expanded}
        tracksId={tracksId}
      />
      {expanded ? (
        <div
          id={tracksId}
          className="activity-album__tracks"
          role="group"
          aria-label="Album tracks"
        >
          {request.albumGrab.fallbackReason ? (
            <p className="activity-album__notice">{request.albumGrab.fallbackReason}</p>
          ) : null}
          {request.children.map((child) => (
            <ActivityRequestRow key={child.id} request={child} {...actions} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
