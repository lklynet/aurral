import { AlertTriangle, Clock } from "lucide-react";
import { DotLoader } from "./DotLoader";
import RelativeTime from "./RelativeTime";

export default function DiscoveryStatusPill({
  isUpdating = false,
  lastUpdated = null,
  updateProgressMessage,
  error = null,
}) {
  if (isUpdating) {
    return (
      <span role="status" className="artist-discover-hero__updated artist-discover-hero__updated--refreshing">
        <DotLoader size="sm" label={null} className="artist-discover-hero__updated-icon" />
        {updateProgressMessage || "Refreshing discovery..."}
      </span>
    );
  }

  if (error) {
    return (
      <span role="status" className="artist-discover-hero__updated">
        <AlertTriangle className="artist-discover-hero__updated-icon" aria-hidden="true" />
        {lastUpdated ? (
          <>
            Refresh failed · Updated <RelativeTime value={lastUpdated} unit="day" />
          </>
        ) : (
          "Refresh failed"
        )}
      </span>
    );
  }

  if (lastUpdated) {
    return (
      <span role="status" className="artist-discover-hero__updated">
        <Clock className="artist-discover-hero__updated-icon" aria-hidden="true" />
        <span>
          Updated <RelativeTime value={lastUpdated} unit="day" />
        </span>
      </span>
    );
  }

  return null;
}
