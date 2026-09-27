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
