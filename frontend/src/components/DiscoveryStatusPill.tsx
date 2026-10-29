import { AlertTriangle } from "./icons";
import { DotLoader } from "./DotLoader";

interface DiscoveryStatusPillProps {
  isUpdating?: boolean;
  updateProgressMessage?: string | null;
  error?: string | null;
}

export default function DiscoveryStatusPill({
  isUpdating = false,
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
        Refresh failed
      </span>
    );
  }

  return null;
}
