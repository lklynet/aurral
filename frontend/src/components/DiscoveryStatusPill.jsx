import { AlertTriangle, Clock } from "lucide-react";
import { formatDate } from "../utils/dateTime.js";
import { DotLoader } from "./DotLoader";

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
        {lastUpdated
          ? `Refresh failed · Updated ${formatDate(new Date(lastUpdated))}`
          : "Refresh failed"}
      </span>
    );
  }

  if (lastUpdated) {
    return (
      <span role="status" className="artist-discover-hero__updated">
        <Clock className="artist-discover-hero__updated-icon" aria-hidden="true" />
        Updated {formatDate(new Date(lastUpdated))}
      </span>
    );
  }

  return null;
}
