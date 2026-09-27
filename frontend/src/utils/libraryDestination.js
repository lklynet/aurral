const MANAGER_NAMES = {
  aurral: "Aurral",
  lidarr: "Lidarr",
};

export const ADD_TO_MENU_LABEL = "Add to…";

export const normalizeLibraryManager = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.hasOwn(MANAGER_NAMES, normalized) ? normalized : null;
};

export const getAddToManagerLabel = (manager) =>
  `Add to ${MANAGER_NAMES[normalizeLibraryManager(manager)] || MANAGER_NAMES.aurral}`;

export const getManagedByLabel = (manager) => {
  const normalized = normalizeLibraryManager(manager);
  return normalized ? `Managed by ${MANAGER_NAMES[normalized]}` : null;
};

export const resolveLibraryDestination = ({ libraryOwner = null, lidarrConfigured = false } = {}) => {
  const available = lidarrConfigured ? ["lidarr", "aurral"] : ["aurral"];
  const saved = normalizeLibraryManager(libraryOwner);
  const primary = available.includes(saved) ? saved : available[0];
  return {
    primary,
    alternative: available.find((manager) => manager !== primary) ?? null,
  };
};

export const getItemDestination = (managedBy, destination = {}) => {
  const manager = normalizeLibraryManager(managedBy);
  return manager ? { ...destination, primary: manager, alternative: null } : destination;
};

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
