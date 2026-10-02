const MANAGER_NAMES = {
  aurral: "Aurral",
  lidarr: "Lidarr",
};

export const normalizeLibraryManager = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.hasOwn(MANAGER_NAMES, normalized) ? normalized : null;
};

export const resolveAlbumManager = (album) =>
  normalizeLibraryManager(album?.managedBy) ||
  (Array.isArray(album?.sources) && album.sources.includes("lidarr") ? "lidarr" : null);

export const canRemoveLibraryAlbum = (album, { lidarrConnected = false } = {}) => {
  const manager = resolveAlbumManager(album);
  if (manager === "aurral") return true;
  return manager === "lidarr" && lidarrConnected &&
    Boolean(album.mbid || album.releaseGroupMbid || album.providerId);
};

export const getDestinationName = (manager) =>
  normalizeLibraryManager(manager) === "lidarr" ? "Lidarr" : "your library";

export const getRemovalTarget = (manager, activeManager) => {
  if (normalizeLibraryManager(manager) === "lidarr") return "Lidarr";
  return activeManager === "lidarr" ? "Aurral" : "library";
};

export const describeRemovalTarget = (manager, activeManager) => {
  const target = getRemovalTarget(manager, activeManager);
  return target === "library" ? "your library" : target;
};

export const getManagerName = (manager) =>
  MANAGER_NAMES[normalizeLibraryManager(manager)] || MANAGER_NAMES.aurral;

export const getAddToManagerLabel = (manager) =>
  normalizeLibraryManager(manager) === "lidarr" ? "Add to Lidarr" : "Add to library";

export const getManagedByLabel = (manager) => {
  const normalized = normalizeLibraryManager(manager);
  return normalized ? `Managed by ${MANAGER_NAMES[normalized]}` : null;
};

export const resolveLibraryDestination = ({ lidarrConfigured = false } = {}) => ({
  primary: lidarrConfigured ? "lidarr" : "aurral",
});

const describeAvailability = (availability) => {
  if (!availability) return null;
  if (availability.available) return "Available";
  const trackCount = Number(availability.trackCount || 0);
  if (trackCount <= 0) return null;
  return `${Number(availability.availableTrackCount || 0)} of ${trackCount} tracks`;
};

export const getLibraryOwnerConflict = (error) => {
  const response = error?.response;
  const data = response?.data || {};
  if (response?.status !== 409 || !String(data.code || "").endsWith("_owner_conflict")) {
    return null;
  }
  const managedBy = normalizeLibraryManager(data.managedBy ?? data.conflict?.managedBy);
  if (!managedBy) return null;
  const label = getManagedByLabel(managedBy);
  const availability = describeAvailability(data.availability ?? data.conflict?.availability);
  return {
    managedBy,
    label,
    message: availability ? `${label} · ${availability}` : label,
  };
};

export const buildArtistAddPayload = ({
  artistMbid,
  artistName,
  managedBy,
  lidarrOptions = {},
  ...rest
}) => ({
  ...rest,
  foreignArtistId: artistMbid,
  artistName,
  managedBy,
  ...(managedBy === "lidarr" ? lidarrOptions : {}),
});

export const buildAlbumRequestPayload = ({
  albumMbid,
  albumName,
  artistMbid,
  artistName,
  managedBy,
  triggerSearch = false,
}) => ({
  albumMbid,
  albumName,
  artistMbid,
  artistName,
  managedBy,
  triggerSearch,
});

export const getMonitorOptionsForManager = (options, managedBy) =>
  normalizeLibraryManager(managedBy) === "aurral"
    ? options.filter((option) => option.value !== "existing")
    : options;
