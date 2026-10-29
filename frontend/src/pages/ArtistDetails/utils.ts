import { RELEASE_LIST_VIEW_MODE_KEY } from "./constants.ts";
import { TAG_COLORS } from "../discoverUtils.ts";
import { shouldTriggerAlbumSearch } from "../../utils/albumAddAction.ts";
import { formatDate } from "../../utils/dateTime.ts";
import { formatCompactNumber } from "../../utils/numberFormat.ts";
import { asApiError } from "../../utils/api/core.ts";
import type { ArtistDetailsResponse } from "../../utils/api/endpoints/artists.ts";
import type {
  LegacyReleaseGroupSummary,
  toNormalizedAlbum,
} from "../../../../backend/services/providers/brainzmashMappers.ts";

export type ReleaseListViewMode = "grid" | "list";

export type ReleaseRating = NonNullable<ReturnType<typeof toNormalizedAlbum>["rating"]>;

export type ReleaseGroup = Partial<LegacyReleaseGroupSummary> & {
  mbid?: string | null;
  foreignAlbumId?: string | null;
  releaseDate?: string | null;
  firstReleaseDate?: string | null;
  listenerCount?: number | null;
  coverUrl?: string | null;
  _coverUrl?: string | null;
  _deezerAlbumId?: string | number | null;
};

export interface ReleaseTrack {
  length?: number | null;
  duration_ms?: number | null;
}

export interface ReleaseMetricValue {
  label: string;
  sortValue: number;
  type: "listeners" | "rating";
  title: string;
}

export interface PlayableTrack {
  previewProvider?: string | null;
  streamPath?: string | null;
}

export interface ArtistCoverImage {
  image: string | null;
  front?: boolean;
  types?: string[];
  coverType?: string;
  kind?: string;
  CoverType?: string;
}

export interface ReleaseLibraryInfo {
  inLibrary?: boolean;
  managedBy?: string | null;
  monitored?: boolean;
  trackListComplete?: boolean;
  trackCount?: number;
  trackFileCount?: number;
  percentOfTracks?: number;
  sizeOnDisk?: number;
}

export interface ReleaseDownloadStatus {
  status?: string | null;
}

interface ReleaseLibraryDisplay {
  kind: "missing" | "complete" | "failed" | "active" | "incomplete" | "monitored" | "unmonitored";
  label: string | null;
  isComplete: boolean;
  isInLibrary: boolean;
}

export type ReleaseGroupStatusLookup = (
  releaseGroupId: string,
) => { status?: string | null } | null | undefined;

interface LibraryAlbum extends Pick<ReleaseGroup, "mbid" | "foreignAlbumId"> {
  id?: string | number | null;
  artistId?: string | number | null;
  monitored?: boolean;
}

export const getApiErrorText = (error: unknown, key: "message" | "error") => {
  const data = asApiError(error)?.response?.data;
  const value = typeof data === "object" && data ? data[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

export const getApiErrorMessage = (error: unknown) =>
  getApiErrorText(error, "message") ||
  getApiErrorText(error, "error") ||
  asApiError(error)?.message;

export const readReleaseListViewMode = (): ReleaseListViewMode => {
  if (typeof window === "undefined") return "grid";
  try {
    const value = window.localStorage.getItem(RELEASE_LIST_VIEW_MODE_KEY);
    return value === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};

export const writeReleaseListViewMode = (mode: ReleaseListViewMode) => {
  if (typeof window === "undefined") return;
  if (mode !== "grid" && mode !== "list") return;
  try {
    window.localStorage.setItem(RELEASE_LIST_VIEW_MODE_KEY, mode);
  } catch {}
};

export const getTagColor = (name: string | null | undefined) => {
  if (!name) return "#121212";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
};

export const isVisibleLibraryAlbum = (
  album: LibraryAlbum | null | undefined,
  { requestingAlbum = null }: { requestingAlbum?: string | null } = {},
) => {
  if (!album || String(album.id ?? "").startsWith("pending-")) return false;
  if (album.monitored) return true;
  return (
    !!requestingAlbum &&
    (album.mbid === requestingAlbum || album.foreignAlbumId === requestingAlbum)
  );
};

export const deduplicateAlbums = <T extends LibraryAlbum>(albums: T[]): T[] => {
  const seen = new Map<string | number, boolean>();
  return albums.filter((album) => {
    const key = album.id || `${album.mbid}-${album.artistId}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
};

export const normalizePlaylistNameKey = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const reserveUniquePlaylistName = (
  playlists: readonly { name?: string | null }[] | null | undefined,
  baseName = "Playlist",
) => {
  const normalizedBase = String(baseName || "").trim() || "Playlist";
  const existing = new Set(
    (Array.isArray(playlists) ? playlists : [])
      .map((playlist) => normalizePlaylistNameKey(playlist?.name))
      .filter(Boolean),
  );
  if (!existing.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

const normalizeTrackDurationMs = (value: unknown) =>
  value != null && Number.isFinite(Number(value)) ? Number(value) : null;

interface StaticPlaylistTrackInput {
  artistName?: string;
  trackName?: string;
  albumName?: string;
  artistMbid?: string;
  albumMbid?: string;
  releaseMbid?: string | null;
  trackMbid?: string;
  releaseYear?: string | null;
  durationMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  reason?: string | null;
}

export const buildStaticPlaylistTrackPayload = ({
  artistName = "",
  trackName = "",
  albumName = "",
  artistMbid = "",
  albumMbid = "",
  releaseMbid = null,
  trackMbid = "",
  releaseYear = null,
  durationMs = null,
  trackNumber = null,
  discNumber = null,
  reason = null,
}: StaticPlaylistTrackInput = {}) => ({
  artistName,
  trackName,
  albumName,
  artistMbid,
  albumMbid,
  releaseMbid: releaseMbid || null,
  trackMbid,
  releaseYear: releaseYear || null,
  durationMs: normalizeTrackDurationMs(durationMs),
  trackNumber: trackNumber || null,
  discNumber: discNumber || null,
  reason,
  artistAliases: [],
});

export const formatLifeSpan = (
  lifeSpan:
    | { begin?: string | null; end?: string | null; ended?: boolean | null }
    | null
    | undefined,
) => {
  if (!lifeSpan) return null;
  const { begin, end, ended } = lifeSpan;
  if (!begin) return null;
  const beginYear = begin.split("-")[0];
  if (ended && end) {
    const endYear = end.split("-")[0];
    return `${beginYear} - ${endYear}`;
  }
  return `${beginYear} - Present`;
};

const ownText = (table: Partial<Record<string, string>>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const ARTIST_TYPE_LABELS = {
  Person: "Solo artist",
  Group: "Band",
  Orchestra: "Orchestra",
  Choir: "Choir",
  Character: "Character",
  Other: "Other",
};

const DOWNLOAD_STATUS_LABELS = {
  adding: "Adding...",
  searching: "Searching...",
  downloading: "Downloading...",
  moving: "Moving files...",
  added: "Added",
  processing: "Searching...",
  failed: "Failed",
};

export const getArtistType = (type: string | null | undefined) =>
  (type && ownText(ARTIST_TYPE_LABELS, type)) || type;

export const buildTasteArtist = ({
  id,
  name,
  tags,
  genres,
}: {
  id: string | undefined;
  name: string;
  tags: ArtistDetailsResponse["tags"] | undefined;
  genres: ArtistDetailsResponse["genres"] | undefined;
}) => ({
  id,
  name,
  tags: (tags || []).map((tag) => tag.name),
  genres: genres || [],
});

export const getDownloadStatusLabel = (status: string) =>
  ownText(DOWNLOAD_STATUS_LABELS, status) || status;

export const getCoverImage = (coverImages: readonly ArtistCoverImage[] | null | undefined) => {
  if (!coverImages?.length) return null;
  const front = coverImages.find((img) => img.front);
  return front?.image || coverImages[0]?.image;
};

export const getReleaseGroupCoverUrl = (
  releaseGroup: ReleaseGroup | null | undefined,
  albumCovers: Record<string, string | undefined> = {},
  {
    artistFallback = "",
    resolved = false,
  }: { artistFallback?: string | null; resolved?: boolean } = {},
) => {
  if (!releaseGroup) return "";
  const id = releaseGroup.id || releaseGroup.mbid || releaseGroup.foreignAlbumId;
  const albumCover =
    (id && albumCovers[id]) || releaseGroup.coverUrl || releaseGroup._coverUrl || "";
  if (albumCover) return albumCover;
  return resolved && artistFallback ? artistFallback : "";
};

const getImageKinds = (image: ArtistCoverImage | null | undefined) => {
  const kinds = [
    image?.coverType,
    image?.kind,
    image?.CoverType,
    ...(Array.isArray(image?.types) ? image.types : []),
  ];
  return kinds.map((kind) =>
    String(kind || "")
      .trim()
      .toLowerCase(),
  );
};

const imageMatchesKinds = (
  image: ArtistCoverImage | null | undefined,
  kinds: readonly string[],
) => {
  const imageKinds = getImageKinds(image);
  return imageKinds.some((kind) => kinds.includes(kind));
};

export const getArtistHeroImage = (coverImages: readonly ArtistCoverImage[] | null | undefined) => {
  if (!coverImages?.length) return null;
  const fanart = coverImages.find((image) =>
    imageMatchesKinds(image, ["fanart", "background", "banner"]),
  );
  return fanart?.image || getCoverImage(coverImages);
};

export const getReleaseYear = (releaseGroupOrAlbum: ReleaseGroup | null | undefined) => {
  const value =
    releaseGroupOrAlbum?.["first-release-date"] ||
    releaseGroupOrAlbum?.releaseDate ||
    releaseGroupOrAlbum?.firstReleaseDate ||
    "";
  const year = String(value || "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : "";
};

export const formatReleaseDate = (releaseGroupOrAlbum: ReleaseGroup | null | undefined) => {
  const value =
    releaseGroupOrAlbum?.["first-release-date"] ||
    releaseGroupOrAlbum?.releaseDate ||
    releaseGroupOrAlbum?.firstReleaseDate ||
    "";
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(date.getTime())) {
      return formatDate(date, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    }
  }
  return getReleaseYear(releaseGroupOrAlbum) || raw;
};

export const sumTrackDurationMs = (tracks: ReleaseTrack[] | null | undefined = []) =>
  (Array.isArray(tracks) ? tracks : []).reduce((total, track) => {
    const length = Number(track?.length || track?.duration_ms || 0);
    return Number.isFinite(length) && length > 0 ? total + length : total;
  }, 0);

export const formatAlbumDuration = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
};

const getReleaseTypeLabel = (release: ReleaseGroup | null | undefined) => {
  const types = [
    release?.["primary-type"],
    ...(Array.isArray(release?.["secondary-types"]) ? release["secondary-types"] : []),
  ].filter(Boolean);
  return types.length ? types.join(" · ") : null;
};

export const mergeReleaseDetails = <T extends ReleaseGroup | undefined>(
  baseRelease: T,
  details: ReleaseGroup | null | undefined,
): T | ReleaseGroup => {
  if (!details) return baseRelease;
  const base = baseRelease!;
  return {
    ...base,
    title: details.title || base.title,
    "first-release-date": details["first-release-date"] || base["first-release-date"],
    "primary-type": details["primary-type"] || base["primary-type"],
    "secondary-types":
      Array.isArray(details["secondary-types"]) && details["secondary-types"].length
        ? details["secondary-types"]
        : base["secondary-types"],
    rating: details.rating || base.rating || null,
    _coverUrl: details.coverUrl || base._coverUrl || "",
  };
};

export const buildReleaseHeaderMeta = (
  release: ReleaseGroup,
  tracks: ReleaseTrack[] | null | undefined = [],
) => {
  const trackCount = Array.isArray(tracks) ? tracks.length : 0;
  const metric = getReleaseMetric(release);
  return [
    formatReleaseDate(release),
    getReleaseTypeLabel(release),
    trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : null,
    formatAlbumDuration(sumTrackDurationMs(tracks)),
    metric.label ? `${metric.label} ${metric.type === "rating" ? "rating" : "listeners"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

export const resolveReleaseLibraryDisplay = (
  libraryInfo: ReleaseLibraryInfo | null | undefined,
  downloadStatus: ReleaseDownloadStatus | null | undefined,
) => {
  const withAction = (display: ReleaseLibraryDisplay) => ({
    ...display,
    triggerSearch: shouldTriggerAlbumSearch({
      inLibrary: display.isInLibrary,
      monitored: libraryInfo?.monitored,
      status: downloadStatus?.status,
      percentOfTracks: libraryInfo?.percentOfTracks,
      sizeOnDisk: libraryInfo?.sizeOnDisk,
      trackFileCount: libraryInfo?.trackFileCount,
    }),
  });

  if (!libraryInfo?.inLibrary) {
    return withAction({
      kind: "missing",
      label: null,
      isComplete: false,
      isInLibrary: false,
    });
  }

  const percent = Number(libraryInfo.percentOfTracks || 0);
  const sizeOnDisk = Number(libraryInfo.sizeOnDisk || 0);
  const trackFileCount = Number(libraryInfo.trackFileCount || 0);
  const trackCount = Number(libraryInfo.trackCount || 0);
  const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
  const isComplete =
    libraryInfo.trackListComplete !== false &&
    (trackCount > 0 ? percent >= 100 || trackFileCount >= trackCount : hasFiles);

  if (isComplete) {
    return withAction({
      kind: "complete",
      label: "In library",
      isComplete: true,
      isInLibrary: true,
    });
  }

  const activeStatus = String(downloadStatus?.status || "").trim();
  if (activeStatus && activeStatus !== "partial") {
    return withAction({
      kind: activeStatus === "failed" ? "failed" : "active",
      label: getDownloadStatusLabel(activeStatus),
      isComplete: false,
      isInLibrary: true,
    });
  }

  if (libraryInfo.trackListComplete === false || percent > 0) {
    return withAction({
      kind: "incomplete",
      label: libraryInfo.trackListComplete === false ? "Incomplete" : `Incomplete · ${percent}%`,
      isComplete: false,
      isInLibrary: true,
    });
  }

  if (libraryInfo.monitored) {
    return withAction({
      kind: "monitored",
      label: "Monitored",
      isComplete: false,
      isInLibrary: true,
    });
  }

  return withAction({
    kind: "unmonitored",
    label: null,
    isComplete: false,
    isInLibrary: true,
  });
};

const getReleaseListeners = (releaseGroup: ReleaseGroup | null | undefined) =>
  Number.isFinite(releaseGroup?.listenerCount) && releaseGroup!.listenerCount! > 0
    ? releaseGroup!.listenerCount!
    : 0;

export const getReleaseMetric = (
  releaseGroup: ReleaseGroup | null | undefined,
): ReleaseMetricValue => {
  const listeners = getReleaseListeners(releaseGroup);
  if (listeners > 0) {
    return {
      label: formatCompactNumber(listeners),
      sortValue: listeners,
      type: "listeners",
      title: `${listeners.toLocaleString()} listeners on ListenBrainz`,
    };
  }

  const ratingValue =
    releaseGroup?.rating?.value != null && Number.isFinite(Number(releaseGroup.rating.value))
      ? Number(releaseGroup.rating.value)
      : null;
  if (ratingValue != null) {
    return {
      label: ratingValue.toFixed(1),
      sortValue: 0,
      type: "rating",
      title: `Rating: ${ratingValue.toFixed(1)}`,
    };
  }

  return { label: "", sortValue: 0, type: "listeners", title: "" };
};

const RELEASE_KIND_ORDER = ["Album", "EP", "Single"];

const getReleaseKindRank = (releaseGroup: ReleaseGroup | null | undefined) => {
  if (releaseGroup?.["secondary-types"]?.length) return RELEASE_KIND_ORDER.length;
  const primaryType = releaseGroup?.["primary-type"];
  const rank = primaryType ? RELEASE_KIND_ORDER.indexOf(primaryType) : -1;
  return rank === -1 ? RELEASE_KIND_ORDER.length : rank;
};

const compareReleaseGroupsByPopularity = (a: ReleaseGroup, b: ReleaseGroup) =>
  getReleaseMetric(b).sortValue - getReleaseMetric(a).sortValue ||
  getReleaseKindRank(a) - getReleaseKindRank(b) ||
  String(b?.["first-release-date"] || "").localeCompare(String(a?.["first-release-date"] || ""));

export const sortReleaseGroupsByPopularity = <T extends ReleaseGroup>(releaseGroups: T[] = []) =>
  [...releaseGroups].sort(compareReleaseGroupsByPopularity);

export const getPopularReleaseGroups = <T extends ReleaseGroup>(
  releaseGroups: T[] = [],
  limit = 6,
) => sortReleaseGroupsByPopularity(releaseGroups).slice(0, limit);

const isUnrequestedReleaseGroup = (
  getAlbumStatus: ReleaseGroupStatusLookup | undefined,
  releaseGroupId: string,
) => {
  const status = getAlbumStatus?.(releaseGroupId)?.status;
  return !status || status === "unmonitored";
};

export const buildAurralPick = <T extends ReleaseGroup>({
  releaseGroups = [],
  getAlbumStatus,
  requestedReleaseGroupId = null,
}: {
  releaseGroups?: T[];
  getAlbumStatus?: ReleaseGroupStatusLookup;
  requestedReleaseGroupId?: string | null;
} = {}) => {
  const releaseGroup =
    releaseGroups.find(
      (item): item is T & { id: string } => !!item?.id && item.id === requestedReleaseGroupId,
    ) ||
    releaseGroups
      .filter(
        (item): item is T & { id: string } =>
          !!item?.id && isUnrequestedReleaseGroup(getAlbumStatus, item.id),
      )
      .sort(
        (a, b) =>
          getReleaseKindRank(a) - getReleaseKindRank(b) || compareReleaseGroupsByPopularity(a, b),
      )[0];
  if (!releaseGroup) return null;
  return {
    releaseGroupId: releaseGroup.id,
    title: releaseGroup.title || "Untitled release",
    type: releaseGroup["primary-type"] || "Release",
    releaseGroup,
  };
};

export const isLibraryPlaybackTrack = (track: PlayableTrack | null | undefined) =>
  track?.previewProvider === "lidarr" || !!track?.streamPath;

export const getTrackPlayAccessibilityLabel = (
  track: PlayableTrack | null | undefined,
  isPlaying: boolean,
) => {
  const fromLibrary = isLibraryPlaybackTrack(track);
  if (isPlaying) {
    return fromLibrary ? "Pause library playback" : "Pause preview";
  }
  return fromLibrary ? "Play from library" : "Play preview";
};
