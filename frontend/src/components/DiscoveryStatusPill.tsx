import { AlertTriangle, Clock } from "./icons";
import { DotLoader } from "./DotLoader";
import RelativeTime from "./RelativeTime";

interface DiscoveryStatusPillProps {
  isUpdating?: boolean;
  lastUpdated?: string | null;
  updateProgressMessage?: string | null;
  error?: string | null;
}

export default function DiscoveryStatusPill({
  isUpdating = false,
  lastUpdated = null,
  updateProgressMessage,
  error = null,
}: DiscoveryStatusPillProps) {
  if (isUpdating) {
    return (
      <span
        role="status"
        className="artist-discover-hero__updated artist-discover-hero__updated--refreshing"
      >
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
