import {
  RELEASE_LIST_VIEW_MODE_KEY,
} from "./constants.js";
import { TAG_COLORS } from "../discoverUtils.js";
import { shouldTriggerAlbumSearch } from "../../utils/albumAddAction.js";
import { formatDate } from "../../utils/dateTime.js";
import { formatCompactNumber } from "../../utils/numberFormat.js";

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

export const isVisibleLibraryAlbum = (album, { requestingAlbum = null } = {}) => {
  if (!album || String(album.id ?? "").startsWith("pending-")) return false;
  if (album.monitored) return true;
  return (
    !!requestingAlbum &&
    (album.mbid === requestingAlbum || album.foreignAlbumId === requestingAlbum)
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

export const normalizePlaylistNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const reserveUniquePlaylistName = (playlists, baseName = "Playlist") => {
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

const normalizeTrackDurationMs = (value) =>
  value != null && Number.isFinite(Number(value)) ? Number(value) : null;

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
} = {}) => ({
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
    Person: "Solo artist",
    Group: "Band",
    Orchestra: "Orchestra",
    Choir: "Choir",
    Character: "Character",
    Other: "Other",
  };
  return types[type] || type;
};

export const getCoverImage = (coverImages) => {
  if (!coverImages?.length) return null;
  const front = coverImages.find((img) => img.front);
  return front?.image || coverImages[0]?.image;
};

export const getReleaseGroupCoverUrl = (
  releaseGroup,
  albumCovers = {},
  { artistFallback = "", resolved = false } = {},
) => {
  if (!releaseGroup) return "";
  const id = releaseGroup.id || releaseGroup.mbid || releaseGroup.foreignAlbumId;
  const albumCover =
    (id && albumCovers[id]) || releaseGroup.coverUrl || releaseGroup._coverUrl || "";
  if (albumCover) return albumCover;
  return resolved && artistFallback ? artistFallback : "";
};

const getImageKinds = (image) => {
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

const imageMatchesKinds = (image, kinds) => {
  const imageKinds = getImageKinds(image);
  return imageKinds.some((kind) => kinds.includes(kind));
};

export const getArtistHeroImage = (coverImages) => {
  if (!coverImages?.length) return null;
  const fanart = coverImages.find((image) =>
    imageMatchesKinds(image, ["fanart", "background", "banner"]),
  );
  return fanart?.image || getCoverImage(coverImages);
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

const getReleaseTypeLabel = (release) => {
  const types = [
    release?.["primary-type"],
    ...(Array.isArray(release?.["secondary-types"]) ? release["secondary-types"] : []),
  ].filter(Boolean);
  return types.length ? types.join(" · ") : null;
};

export const mergeReleaseDetails = (baseRelease, details) => {
  if (!details) return baseRelease;
  return {
    ...baseRelease,
    title: details.title || baseRelease.title,
    "first-release-date": details["first-release-date"] || baseRelease["first-release-date"],
    "primary-type": details["primary-type"] || baseRelease["primary-type"],
    "secondary-types":
      Array.isArray(details["secondary-types"]) && details["secondary-types"].length
        ? details["secondary-types"]
        : baseRelease["secondary-types"],
    rating: details.rating || baseRelease.rating || null,
    _coverUrl: details.coverUrl || baseRelease._coverUrl || "",
  };
};

export const buildReleaseHeaderMeta = (release, tracks = []) => {
  const typeLabel = getReleaseTypeLabel(release);
  const trackCount = Array.isArray(tracks) ? tracks.length : 0;
  const metric = getReleaseMetric(release);
  const meta = [
    formatReleaseDate(release),
    typeLabel,
    trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : null,
    formatAlbumDuration(sumTrackDurationMs(tracks)),
    metric.label ? `${metric.label} ${metric.type === "rating" ? "rating" : "listeners"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { typeLabel, meta };
};

export const resolveReleaseLibraryDisplay = (libraryInfo, downloadStatus) => {
  const withAction = (display) => ({
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
    const labels = {
      adding: "Adding...",
      searching: "Searching...",
      downloading: "Downloading...",
      moving: "Moving files...",
      added: "Added",
      processing: "Searching...",
      failed: "Failed",
    };
    return withAction({
      kind: activeStatus === "failed" ? "failed" : "active",
      label: labels[activeStatus] || activeStatus,
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

const getReleaseListeners = (releaseGroup) =>
  Number.isFinite(releaseGroup?.listenerCount) && releaseGroup.listenerCount > 0
    ? releaseGroup.listenerCount
    : 0;

export const getReleaseMetric = (releaseGroup) => {
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

const getReleaseKindRank = (releaseGroup) => {
  if (releaseGroup?.["secondary-types"]?.length) return RELEASE_KIND_ORDER.length;
  const rank = RELEASE_KIND_ORDER.indexOf(releaseGroup?.["primary-type"]);
  return rank === -1 ? RELEASE_KIND_ORDER.length : rank;
};

const compareReleaseGroupsByPopularity = (a, b) =>
  getReleaseMetric(b).sortValue - getReleaseMetric(a).sortValue ||
  getReleaseKindRank(a) - getReleaseKindRank(b) ||
  String(b?.["first-release-date"] || "").localeCompare(String(a?.["first-release-date"] || ""));

export const sortReleaseGroupsByPopularity = (releaseGroups = []) =>
  [...releaseGroups].sort(compareReleaseGroupsByPopularity);

export const getPopularReleaseGroups = (releaseGroups = [], limit = 6) =>
  sortReleaseGroupsByPopularity(releaseGroups).slice(0, limit);

const isUnrequestedReleaseGroup = (getAlbumStatus, releaseGroupId) => {
  const status = getAlbumStatus?.(releaseGroupId)?.status;
  return !status || status === "unmonitored";
};

export const buildAurralPick = ({
  releaseGroups = [],
  getAlbumStatus,
  requestedReleaseGroupId = null,
} = {}) => {
  const releaseGroup =
    releaseGroups.find((item) => item?.id && item.id === requestedReleaseGroupId) ||
    releaseGroups
      .filter((item) => item?.id && isUnrequestedReleaseGroup(getAlbumStatus, item.id))
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

export const isLibraryPlaybackTrack = (track) =>
  track?.previewProvider === "lidarr" || !!track?.streamPath;

export const getTrackPlayAccessibilityLabel = (track, isPlaying) => {
  const fromLibrary = isLibraryPlaybackTrack(track);
  if (isPlaying) {
    return fromLibrary ? "Pause library playback" : "Pause preview";
  }
  return fromLibrary ? "Play from library" : "Play preview";
};
