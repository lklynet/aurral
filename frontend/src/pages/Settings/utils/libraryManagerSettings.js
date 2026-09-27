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
