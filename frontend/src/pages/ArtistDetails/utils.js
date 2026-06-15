import {
  RELEASE_LIST_VIEW_MODE_KEY,
  TAG_COLORS,
  allReleaseTypes,
  secondaryReleaseTypes,
} from "./constants";

export const readReleaseListViewMode = () => {
  if (typeof window === "undefined") return "grid";
  try {
    const value = window.localStorage.getItem(RELEASE_LIST_VIEW_MODE_KEY);
    return value === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};

export const writeReleaseListViewMode = (mode) => {
  if (typeof window === "undefined") return;
  if (mode !== "grid" && mode !== "list") return;
  try {
    window.localStorage.setItem(RELEASE_LIST_VIEW_MODE_KEY, mode);
  } catch {}
};

export const getTagColor = (name) => {
  if (!name) return "#121212";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
};

export const getPopularityScale = (releaseGroups) => {
  if (!Array.isArray(releaseGroups) || releaseGroups.length === 0) {
    return { pivot: 0 };
  }
  const counts = releaseGroups
    .map((rg) => (typeof rg?.fans === "number" ? rg.fans : 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (counts.length === 0) return { pivot: 0 };
  const mid = Math.floor(counts.length / 2);
  const pivot =
    counts.length % 2 === 0 ? (counts[mid - 1] + counts[mid]) / 2 : counts[mid];
  return { pivot };
};

export const segmentsFromScale = (count, pivot, totalSegments = 10) => {
  const safeCount = typeof count === "number" ? count : 0;
  if (safeCount <= 0) return 0;
  const safePivot = Number.isFinite(pivot) && pivot > 0 ? pivot : safeCount;
  const logRatio = Math.log(safeCount / safePivot);
  const slope = 0.6;
  const scaled = 1 / (1 + Math.exp(-slope * logRatio));
  const clamped = Math.min(1, Math.max(0, scaled));
  return Math.round(clamped * totalSegments);
};

export const isVisibleLibraryAlbum = (
  album,
  { requestingAlbum = null } = {},
) => {
  if (!album || String(album.id ?? "").startsWith("pending-")) return false;
  if (album.monitored) return true;
  return (
    !!requestingAlbum &&
    (album.mbid === requestingAlbum ||
      album.foreignAlbumId === requestingAlbum)
  );
};

export const deduplicateAlbums = (albums) => {
  const seen = new Map();
  return albums.filter((album) => {
    const key = album.id || `${album.mbid}-${album.artistId}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
};

export const formatLifeSpan = (lifeSpan) => {
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

export const getArtistType = (type) => {
  const types = {
    Person: "Solo Artist",
    Group: "Band",
    Orchestra: "Orchestra",
    Choir: "Choir",
    Character: "Character",
    Other: "Other",
  };
  return types[type] || type;
};

export const matchesReleaseTypeFilter = (
  releaseGroup,
  selectedReleaseTypes,
) => {
  if (!selectedReleaseTypes || selectedReleaseTypes.length === 0) return true;
  const primaryType = releaseGroup["primary-type"];
  const secondaryTypes = releaseGroup["secondary-types"] || [];
  if (!selectedReleaseTypes.includes(primaryType)) return false;
  if (secondaryTypes.length > 0) {
    const normalizedSecondaryTypes = [
      ...new Set(
        secondaryTypes.map((secondaryType) =>
          secondaryReleaseTypes.includes(secondaryType)
            ? secondaryType
            : "Other",
        ),
      ),
    ];
    return normalizedSecondaryTypes.every((secondaryType) =>
      selectedReleaseTypes.includes(secondaryType),
    );
  }
  return true;
};

export const hasActiveFilters = (selectedReleaseTypes) => {
  if (selectedReleaseTypes.length !== allReleaseTypes.length) return true;
  return !allReleaseTypes.every((type) => selectedReleaseTypes.includes(type));
};

export const getCoverImage = (coverImages) => {
  if (!coverImages?.length) return null;
  const front = coverImages.find((img) => img.front);
  return front?.image || coverImages[0]?.image;
};

const getImageKinds = (image) => {
  const kinds = [
    image?.coverType,
    image?.kind,
    image?.CoverType,
    ...(Array.isArray(image?.types) ? image.types : []),
  ];
  return kinds.map((kind) => String(kind || "").trim().toLowerCase());
};

const imageMatchesKinds = (image, kinds) => {
  const imageKinds = getImageKinds(image);
  return imageKinds.some((kind) => kinds.includes(kind));
};

export const getArtistPosterImage = (coverImages) => getCoverImage(coverImages);

export const getArtistHeroImage = (coverImages) => {
  if (!coverImages?.length) return null;
  const fanart = coverImages.find((image) =>
    imageMatchesKinds(image, ["fanart", "background", "banner"]),
  );
  return fanart?.image || getArtistPosterImage(coverImages);
};

export const getReleaseYear = (releaseGroupOrAlbum) => {
  const value =
    releaseGroupOrAlbum?.["first-release-date"] ||
    releaseGroupOrAlbum?.releaseDate ||
    releaseGroupOrAlbum?.firstReleaseDate ||
    "";
  const year = String(value || "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : "";
};

export const formatReleaseDate = (releaseGroupOrAlbum) => {
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
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    }
  }
  return getReleaseYear(releaseGroupOrAlbum) || raw;
};

export const sumTrackDurationMs = (tracks = []) =>
  (Array.isArray(tracks) ? tracks : []).reduce((total, track) => {
    const length = Number(track?.length || track?.duration_ms || 0);
    return Number.isFinite(length) && length > 0 ? total + length : total;
  }, 0);

export const formatAlbumDuration = (durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
};

export const resolveReleaseLibraryDisplay = (libraryInfo, downloadStatus) => {
  if (!libraryInfo?.inLibrary) {
    return {
      kind: "missing",
      label: null,
      isComplete: false,
      isInLibrary: false,
    };
  }

  const percent = Number(libraryInfo.percentOfTracks || 0);
  const sizeOnDisk = Number(libraryInfo.sizeOnDisk || 0);
  const trackFileCount = Number(libraryInfo.trackFileCount || 0);
  const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
  const isComplete = hasFiles;

  if (isComplete) {
    return {
      kind: "complete",
      label: "In library",
      isComplete: true,
      isInLibrary: true,
    };
  }

  const activeStatus = String(downloadStatus?.status || "").trim();
  if (activeStatus) {
    const labels = {
      adding: "Adding...",
      searching: "Searching...",
      downloading: "Downloading...",
      moving: "Moving files...",
      added: "Added",
      processing: "Searching...",
      failed: "Failed",
    };
    return {
      kind: activeStatus === "failed" ? "failed" : "active",
      label: labels[activeStatus] || activeStatus,
      isComplete: false,
      isInLibrary: true,
    };
  }

  if (percent > 0) {
    return {
      kind: "incomplete",
      label: `Incomplete · ${percent}%`,
      isComplete: false,
      isInLibrary: true,
    };
  }

  if (libraryInfo.monitored) {
    return {
      kind: "monitored",
      label: "Monitored",
      isComplete: false,
      isInLibrary: true,
    };
  }

  return {
    kind: "unmonitored",
    label: null,
    isComplete: false,
    isInLibrary: true,
  };
};

export const getReleaseMetric = (releaseGroup) => {
  const ratingValue =
    releaseGroup?.rating?.value != null &&
    Number.isFinite(Number(releaseGroup.rating.value))
      ? Number(releaseGroup.rating.value)
      : null;
  if (ratingValue != null) {
    return {
      label: ratingValue.toFixed(1),
      sortValue: ratingValue * 1000000,
      type: "rating",
      title: `Rating: ${ratingValue.toFixed(1)}`,
    };
  }

  const fans = typeof releaseGroup?.fans === "number" ? releaseGroup.fans : 0;
  return {
    label: fans > 0 ? fans.toLocaleString() : "",
    sortValue: fans,
    type: "fans",
    title: fans > 0 ? `${fans.toLocaleString()} listeners` : "",
  };
};

export const sortReleaseGroupsByPopularity = (releaseGroups = []) =>
  [...releaseGroups].sort(
    (a, b) => getReleaseMetric(b).sortValue - getReleaseMetric(a).sortValue,
  );

export const getPopularReleaseGroups = (releaseGroups = [], limit = 6) =>
  sortReleaseGroupsByPopularity(releaseGroups).slice(0, limit);

export const isOwnedReleaseGroup = (getAlbumStatus, releaseGroupId) => {
  const status = getAlbumStatus?.(releaseGroupId);
  return status?.status === "available" || status?.status === "added";
};

export const buildAurralPick = ({
  releaseGroups = [],
  getAlbumStatus,
} = {}) => {
  const releaseGroup = sortReleaseGroupsByPopularity(releaseGroups).find(
    (item) => item?.id && !isOwnedReleaseGroup(getAlbumStatus, item.id),
  );
  if (!releaseGroup) return null;
  const metric = getReleaseMetric(releaseGroup);
  return {
    id: releaseGroup.id,
    source: "release",
    releaseGroupId: releaseGroup.id,
    title: releaseGroup.title || "Untitled release",
    year: getReleaseYear(releaseGroup),
    type: releaseGroup["primary-type"] || "Release",
    releaseGroup,
    libraryAlbum: null,
    downloadStatus: null,
    status: "missing",
    statusLabel: "Missing",
    reason: "Popular missing release",
    metric,
    reasonLabel: "Popular missing release",
  };
};

export const encodeLastfmPathSegment = (value) =>
  encodeURIComponent(String(value || "").trim())
    .replace(/%20/g, "+")
    .replace(/%26/g, "&");

export const buildLastfmArtistUrl = (artistName) =>
  `https://www.last.fm/music/${encodeLastfmPathSegment(artistName)}`;

export const buildLastfmAlbumUrl = (artistName, albumTitle) =>
  `${buildLastfmArtistUrl(artistName)}/${encodeLastfmPathSegment(albumTitle)}`;

export const getArtistReleaseGridColumnCount = () => {
  if (typeof window === "undefined") return 2;
  if (window.matchMedia("(min-width: 1024px)").matches) return 6;
  if (window.matchMedia("(min-width: 640px)").matches) return 3;
  return 2;
};

export const isLibraryPlaybackTrack = (track) =>
  track?.previewProvider === "lidarr" || !!track?.streamPath;

export const getTrackPlayAccessibilityLabel = (track, isPlaying) => {
  const fromLibrary = isLibraryPlaybackTrack(track);
  if (isPlaying) {
    return fromLibrary ? "Pause library playback" : "Pause preview";
  }
  return fromLibrary ? "Play from library" : "Play preview";
};
