import { isUnreleased } from "../../../lib/releaseDate.ts";
import { Download } from "../components/icons";
import { formatCalendarDate } from "./dateTime.ts";

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
  album?: { releaseDate?: string | null } | null;
};

export const buildAlbumAddAction = (releaseDate?: string | null) => ({
  label: isUnreleased(releaseDate) ? "Download when it's out" : "Download album",
  icon: Download,
});

export const getAlbumAddAction = ({ releaseDate }: { releaseDate?: string | null } = {}) =>
  buildAlbumAddAction(releaseDate);

export const isAlbumCompleteInLibrary = ({
  status = "",
  hasFiles = false,
  percentOfTracks = 0,
  sizeOnDisk = 0,
  trackFileCount = 0,
}: {
  status?: string | null;
  hasFiles?: boolean;
  percentOfTracks?: number;
  sizeOnDisk?: number;
  trackFileCount?: number;
} = {}) =>
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
  if (result?.albumStatus?.status === "unreleased") {
    const releaseDate = formatCalendarDate(result.album?.releaseDate);
    return {
      kind: "success",
      message: releaseDate
        ? `${title} comes out ${releaseDate}. Aurral will download it then.`
        : `${title} isn't out yet. Aurral will download it when it comes out.`,
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
