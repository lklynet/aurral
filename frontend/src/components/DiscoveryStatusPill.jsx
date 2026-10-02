import { Clock } from "lucide-react";
import { formatDate } from "../utils/dateTime.js";
import { DotLoader } from "./DotLoader";

export default function DiscoveryStatusPill({
  isUpdating = false,
  lastUpdated = null,
  updateProgressMessage,
}) {
  if (isUpdating) {
    return (
      <span className="artist-discover-hero__updated artist-discover-hero__updated--refreshing">
        <DotLoader size="sm" label={null} className="artist-discover-hero__updated-icon" />
        {updateProgressMessage || "Refreshing discovery..."}
      </span>
    );
  }

  if (lastUpdated) {
    return (
      <span className="artist-discover-hero__updated">
        <Clock className="artist-discover-hero__updated-icon" />
        Updated {formatDate(new Date(lastUpdated))}
      </span>
    );
  }

  return null;
}
