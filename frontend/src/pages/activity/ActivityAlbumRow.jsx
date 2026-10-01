import { useEffect, useId, useState } from "react";
import ActivityRequestRow from "./ActivityRequestRow";
import { matchesActivitySearch } from "./activityListUtils";

export default function ActivityAlbumRow({ request, filterValue, ...actions }) {
  const [expanded, setExpanded] = useState(false);
  const tracksId = useId();
  const hasTrackMatch = Boolean(filterValue.trim())
    && request.children.some((child) => matchesActivitySearch(child, filterValue));

  useEffect(() => {
    if (hasTrackMatch) setExpanded(true);
  }, [hasTrackMatch, filterValue]);

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
        <div id={tracksId} className="activity-album__tracks" role="group" aria-label="Album tracks">
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
