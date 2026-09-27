const LIBRARY_MANAGERS = [
  { id: "aurral", label: "Aurral" },
  { id: "lidarr", label: "Lidarr" },
];

function normalizeManager(value) {
  return LIBRARY_MANAGERS.some((manager) => manager.id === value) ? value : null;
}

export function describeLibraryManagerControl({ libraryOwner, lidarrConfigured }) {
  const value = normalizeManager(libraryOwner?.defaultLibraryOwner);
  const stored = normalizeManager(libraryOwner?.storedDefaultLibraryOwner);
  const lidarrUnavailableReason = lidarrConfigured
    ? null
    : stored === "lidarr"
      ? "Lidarr is not connected. Your saved default stays Lidarr, but Lidarr adds need an admin to reconnect it."
      : "Lidarr is not connected. An admin can connect it in Settings → Lidarr.";

  return {
    value,
    statusLabel: value ? (stored ? "Saved" : "Default") : null,
    canUseDefault: Boolean(stored),
    options: LIBRARY_MANAGERS.map((manager) => ({
      ...manager,
      disabled: manager.id === "lidarr" && !lidarrConfigured,
    })),
    lidarrUnavailableReason,
  };
}

const MEDIA_STAYS_VISIBLE = "Indexed Lidarr media stays visible in your library.";

export function describeLidarrConnectionState({ lidarr, health }) {
  if (lidarr?.enabled === false) {
    return {
      reason: "disabled",
      title: "Lidarr is disabled",
      message: `${MEDIA_STAYS_VISIBLE} Turn Lidarr on to use Lidarr actions again.`,
    };
  }
  if (!String(lidarr?.url || "").trim() || !String(lidarr?.apiKey || "").trim()) {
    return {
      reason: "not-configured",
      title: "Lidarr is not configured",
      message: `${MEDIA_STAYS_VISIBLE} Enter the server URL and API key to use Lidarr actions.`,
    };
  }
  if (health?.lidarr?.circuitOpen === true) {
    return {
      reason: "unreachable",
      title: "Lidarr is unreachable",
      message: `${MEDIA_STAYS_VISIBLE} Aurral paused Lidarr requests after repeated failures. Check that Lidarr is running, then test the connection.`,
    };
  }
  return null;
}
