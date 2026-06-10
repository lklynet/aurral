import {
  TAG_COLORS,
  allReleaseTypes,
  secondaryReleaseTypes,
} from "./constants";

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

const getLibraryAlbumReleaseGroupId = (album) =>
  album?.mbid || album?.foreignAlbumId || "";

const getLibraryAlbumStatusWeight = (album, downloadStatus) => {
  const status = String(downloadStatus?.status || "").toLowerCase();
  if (status === "failed") return 0;
  if (
    ["adding", "searching", "downloading", "moving", "processing"].includes(
      status,
    )
  ) {
    return 1;
  }
  if (album?.monitored) return 2;
  return 3;
};

export const buildDownloadTargets = ({
  artist,
  libraryAlbums = [],
  downloadStatuses = {},
  releaseGroups = [],
} = {}) => {
  const allReleaseGroups =
    releaseGroups.length > 0 ? releaseGroups : artist?.["release-groups"] || [];
  const releaseById = new Map(
    allReleaseGroups.filter((rg) => rg?.id).map((rg) => [rg.id, rg]),
  );
  const seen = new Set();
  const targets = [];

  for (const album of Array.isArray(libraryAlbums) ? libraryAlbums : []) {
    if (!album) continue;
    const releaseGroupId = getLibraryAlbumReleaseGroupId(album);
    const targetKey = releaseGroupId || `library:${album.id}`;
    if (!targetKey || seen.has(targetKey)) continue;
    seen.add(targetKey);

    const percentOfTracks = Number(album.statistics?.percentOfTracks ?? 0);
    const sizeOnDisk = Number(album.statistics?.sizeOnDisk ?? 0);
    const isComplete = percentOfTracks >= 100 || sizeOnDisk > 0;
    const downloadStatus = downloadStatuses?.[album.id];
    const hasActionableState =
      album.monitored ||
      downloadStatus ||
      String(album.id ?? "").startsWith("pending-");
    if (isComplete || !hasActionableState) continue;

    const releaseGroup = releaseById.get(releaseGroupId);
    const metric = getReleaseMetric(releaseGroup);
    const status = String(downloadStatus?.status || "").toLowerCase();
    const statusLabel =
      {
        adding: "Adding",
        searching: "Searching",
        downloading: "Downloading",
        moving: "Moving",
        processing: "Searching",
        failed: "Failed",
      }[status] || (album.monitored ? "Monitored" : "Missing");

    targets.push({
      id: targetKey,
      source: "library",
      releaseGroupId,
      title: album.albumName || releaseGroup?.title || "Untitled release",
      year: getReleaseYear(album) || getReleaseYear(releaseGroup),
      type: album.albumType || releaseGroup?.["primary-type"] || "Album",
      releaseGroup,
      libraryAlbum: album,
      downloadStatus,
      status,
      statusLabel,
      reason:
        status === "failed" ? "Failed download" : "Incomplete library album",
      sortBucket: getLibraryAlbumStatusWeight(album, downloadStatus),
      metric,
    });
  }

  for (const releaseGroup of allReleaseGroups) {
    if (!releaseGroup?.id || seen.has(releaseGroup.id)) continue;
    seen.add(releaseGroup.id);
    const metric = getReleaseMetric(releaseGroup);
    targets.push({
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
      reason:
        metric.sortValue > 0 ? "Popular missing release" : "Newest missing release",
      sortBucket: 4,
      metric,
    });
  }

  return targets
    .sort((a, b) => {
      if (a.sortBucket !== b.sortBucket) return a.sortBucket - b.sortBucket;
      const metricDiff = (b.metric?.sortValue || 0) - (a.metric?.sortValue || 0);
      if (metricDiff !== 0) return metricDiff;
      return String(b.year || "").localeCompare(String(a.year || ""));
    })
    .slice(0, 5);
};

export const buildAurralPick = (downloadTargets = []) => {
  const target = Array.isArray(downloadTargets) ? downloadTargets[0] : null;
  if (!target) return null;
  return {
    ...target,
    reasonLabel:
      target.reason ||
      (target.source === "library"
        ? "Incomplete library album"
        : "Newest missing release"),
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

export const getExpandedReleaseRenderAfterIndex = (
  expandedReleaseIndex,
  itemCount,
  gridColumnCount,
) => {
  if (expandedReleaseIndex < 0) return -1;
  return Math.min(
    expandedReleaseIndex +
      (gridColumnCount - 1 - (expandedReleaseIndex % gridColumnCount)),
    itemCount - 1,
  );
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
