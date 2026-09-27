import { getAddToManagerLabel, getItemDestination } from "./libraryDestination.js";

const ACTIVE_ALBUM_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
  "failed",
]);

export const shouldTriggerAlbumSearch = ({
  inLibrary = false,
  monitored = false,
  status = "",
  hasFiles = false,
  percentOfTracks = 0,
  sizeOnDisk = 0,
  trackFileCount = 0,
} = {}) => {
  const normalizedStatus = String(status || "").trim();
  if (
    hasFiles ||
    normalizedStatus === "available" ||
    normalizedStatus === "added" ||
    Number(percentOfTracks) >= 100 ||
    Number(sizeOnDisk) > 0 ||
    Number(trackFileCount) > 0
  ) {
    return false;
  }
  if (normalizedStatus === "monitored" || ACTIVE_ALBUM_STATUSES.has(normalizedStatus)) {
    return true;
  }
  if (normalizedStatus === "unmonitored" || normalizedStatus === "missing") {
    return false;
  }
  if (normalizedStatus === "inLibrary") {
    return Boolean(monitored);
  }
  return Boolean(inLibrary && monitored);
};

export const getAlbumAddAction = (input = {}, destination = {}) => {
  if (!shouldTriggerAlbumSearch(input)) {
    return { label: getAddToManagerLabel(destination.primary), destination };
  }
  return {
    label: "Search Album",
    destination: { ...getItemDestination(input.managedBy, destination), alternative: null },
  };
};

export const isAlbumCompleteInLibrary = ({
  status = "",
  hasFiles = false,
  percentOfTracks = 0,
  sizeOnDisk = 0,
  trackFileCount = 0,
} = {}) =>
  hasFiles ||
  status === "available" ||
  status === "added" ||
  Number(percentOfTracks) >= 100 ||
  Number(sizeOnDisk) > 0 ||
  Number(trackFileCount) > 0;

export const getAlbumAddButtonLabel = (input = {}) =>
  shouldTriggerAlbumSearch(input) ? "Search Album" : "Add to Lidarr";
