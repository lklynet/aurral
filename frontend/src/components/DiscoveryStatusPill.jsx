import { Loader, Clock } from "lucide-react";
import { formatDate } from "../utils/dateTime.js";

export default function DiscoveryStatusPill({
  isUpdating = false,
  playlistsUpdating = false,
  lastUpdated = null,
  updateProgressMessage,
  playlistsUpdateMessage,
}) {
  if (isUpdating) {
    return (
      <span className="artist-discover-hero__updated artist-discover-hero__updated--refreshing">
        <Loader className="artist-discover-hero__updated-icon animate-spin" />
        {updateProgressMessage || "Refreshing discovery..."}
      </span>
    );
  }

  if (playlistsUpdating) {
    return (
      <span className="artist-discover-hero__updated artist-discover-hero__updated--refreshing">
        <Loader className="artist-discover-hero__updated-icon animate-spin" />
        {playlistsUpdateMessage || "Updating playlists..."}
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
