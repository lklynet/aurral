import { getAddToManagerLabel, getItemDestination, getManagerName } from "./libraryDestination.js";

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

export const buildAlbumAddAction = (search, managedBy, destination = {}) => {
  const itemDestination = getItemDestination(managedBy, destination);
  return search
    ? {
        label: "Search Album",
        destination: { ...itemDestination, alternative: null },
      }
    : { label: getAddToManagerLabel(itemDestination.primary), destination: itemDestination };
};

export const getAlbumAddAction = (input = {}, destination = {}) =>
  buildAlbumAddAction(shouldTriggerAlbumSearch(input), input.managedBy, destination);

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

export const describeAlbumRequestResult = (result, title, managedBy = result?.managedBy) => {
  const manager = getManagerName(managedBy);
  const added = `Added ${title} to ${manager}`;
  if (result?.status === "blocked" || result?.albumStatus?.status === "blocked") {
    return { kind: "info", message: `${added}, but nothing is downloading. Open the album to see why.` };
  }
  if (result?.queued || result?.status === "queued") {
    return { kind: "success", message: `${added}. Downloads queued.` };
  }
  if (result?.triggeredSearch || result?.status === "searching") {
    return { kind: "success", message: `Searching for ${title} in ${manager}` };
  }
  return { kind: "success", message: added };
};
