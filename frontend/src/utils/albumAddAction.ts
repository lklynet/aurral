import { Download } from "../components/icons";
import type { useLibraryDestination } from "../hooks/useLibraryDestination";

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
}: {
  inLibrary?: boolean | null;
  monitored?: boolean;
  status?: string | null;
  hasFiles?: boolean;
  percentOfTracks?: number;
  sizeOnDisk?: number;
  trackFileCount?: number;
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

type ReleaseLibraryInfo = {
  trackCount?: number | null;
  managedBy?: string | null;
  monitored?: boolean | null;
  trackFileCount?: number | null;
  percentOfTracks?: number | null;
};

type AlbumRequestResult = {
  status?: string;
  queued?: boolean;
  triggeredSearch?: boolean;
  albumStatus?: { status?: string } | null;
};

type AlbumDestination = Partial<ReturnType<typeof useLibraryDestination>>;

export const buildAlbumAddAction = (_search: boolean, destination: AlbumDestination = {}) => ({
  label: "Download album",
  icon: Download,
  destination,
});

type AlbumSearchInput = Parameters<typeof shouldTriggerAlbumSearch>[0];

export function getAlbumAddAction<T extends object>(
  input: T & AlbumSearchInput,
  destination?: AlbumDestination,
): ReturnType<typeof buildAlbumAddAction>;
export function getAlbumAddAction(
  input?: AlbumSearchInput,
  destination?: AlbumDestination,
): ReturnType<typeof buildAlbumAddAction>;
export function getAlbumAddAction(
  input: AlbumSearchInput = {},
  destination: AlbumDestination = {},
) {
  return buildAlbumAddAction(shouldTriggerAlbumSearch(input), destination);
}

export const isAlbumCompleteInLibrary = ({
  status = "",
  hasFiles = false,
  percentOfTracks = 0,
  sizeOnDisk = 0,
  trackFileCount = 0,
}: Pick<
  NonNullable<Parameters<typeof shouldTriggerAlbumSearch>[0]>,
  "status" | "hasFiles" | "percentOfTracks" | "sizeOnDisk" | "trackFileCount"
> = {}) =>
  hasFiles ||
  status === "available" ||
  status === "added" ||
  Number(percentOfTracks) >= 100 ||
  Number(sizeOnDisk) > 0 ||
  Number(trackFileCount) > 0;

export const countReleaseTracks = <T extends ReleaseLibraryInfo>(
  libraryInfo: T | null | undefined,
  releaseTrackCount: number,
) => {
  const trackCount = Number(libraryInfo?.trackCount || 0);
  if (
    libraryInfo?.managedBy !== "aurral" ||
    libraryInfo.monitored !== false ||
    releaseTrackCount <= trackCount
  ) {
    return libraryInfo;
  }
  return {
    ...libraryInfo,
    trackCount: releaseTrackCount,
    percentOfTracks: (Number(libraryInfo.trackFileCount || 0) / releaseTrackCount) * 100,
  };
};

export const describeAlbumRequestResult = (
  result: AlbumRequestResult | null | undefined,
  title: string | null | undefined,
) => {
  if (result?.status === "blocked" || result?.albumStatus?.status === "blocked") {
    return {
      kind: "info",
      message: `${title} is in your library, but nothing is downloading. Open the album to see why.`,
    };
  }
  if (result?.queued || result?.status === "queued") {
    return { kind: "success", message: `Downloading ${title}` };
  }
  if (result?.triggeredSearch || result?.status === "searching") {
    return { kind: "success", message: `Searching for ${title}` };
  }
  return { kind: "success", message: `Added ${title} to your library` };
};
