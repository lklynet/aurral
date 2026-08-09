import {
  RELEASE_LIST_VIEW_MODE_KEY,
} from "./constants";
import { TAG_COLORS } from "../discoverUtils";
import { shouldTriggerAlbumSearch } from "../../utils/albumAddAction.js";
import { formatDate } from "../../utils/dateTime.js";

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

export const buildSharedPlaylistTrackPayload = ({
  artistName = "",
  trackName = "",
  albumName = "",
  artistMbid = "",
  albumMbid = "",
  trackMbid = "",
  releaseYear = null,
  durationMs = null,
  reason = null,
} = {}) => ({
  artistName,
  trackName,
  albumName,
  artistMbid,
  albumMbid,
  trackMbid,
  releaseYear: releaseYear || null,
  durationMs: normalizeTrackDurationMs(durationMs),
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
    Person: "Solo Artist",
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
  const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
  const isComplete = hasFiles;

  if (isComplete) {
    return withAction({
      kind: "complete",
      label: "In library",
      isComplete: true,
      isInLibrary: true,
    });
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
    return withAction({
      kind: activeStatus === "failed" ? "failed" : "active",
      label: labels[activeStatus] || activeStatus,
      isComplete: false,
      isInLibrary: true,
    });
  }

  if (percent > 0) {
    return withAction({
      kind: "incomplete",
      label: `Incomplete · ${percent}%`,
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

export const getReleaseMetric = (releaseGroup) => {
  const ratingValue =
    releaseGroup?.rating?.value != null && Number.isFinite(Number(releaseGroup.rating.value))
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
  [...releaseGroups].sort((a, b) => getReleaseMetric(b).sortValue - getReleaseMetric(a).sortValue);

export const getPopularReleaseGroups = (releaseGroups = [], limit = 6) =>
  sortReleaseGroupsByPopularity(releaseGroups).slice(0, limit);

export const isOwnedReleaseGroup = (getAlbumStatus, releaseGroupId) => {
  const status = getAlbumStatus?.(releaseGroupId);
  return status?.status === "available" || status?.status === "added";
};

export const buildAurralPick = ({ releaseGroups = [], getAlbumStatus } = {}) => {
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

export const isLibraryPlaybackTrack = (track) =>
  track?.previewProvider === "lidarr" || !!track?.streamPath;

export const getTrackPlayAccessibilityLabel = (track, isPlaying) => {
  const fromLibrary = isLibraryPlaybackTrack(track);
  if (isPlaying) {
    return fromLibrary ? "Pause library playback" : "Pause preview";
  }
  return fromLibrary ? "Play from library" : "Play preview";
};
