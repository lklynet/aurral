const FORMAT_BY_EXTENSION = {
  mp3: ["mp3"],
  mpeg: ["mp3"],
  m4a: ["m4a"],
  mp4: ["m4a"],
  aac: ["aac"],
  flac: ["flac"],
  ogg: ["ogg"],
  oga: ["ogg"],
  wav: ["wav"],
};

const DEFAULT_FORMAT_ATTEMPTS = ["mp3", "m4a", "flac", "ogg", "aac"];

function extensionFromPath(value) {
  const path = String(value || "").split("?")[0].toLowerCase();
  return path.match(/\.([a-z0-9]+)$/i)?.[1] || null;
}

function qualityToFormat(quality) {
  const normalized = String(quality || "").toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("alac")) return "m4a";
  if (normalized.includes("mp3")) return "mp3";
  if (normalized.includes("aac") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("ogg") || normalized.includes("vorbis")) return "ogg";
  return null;
}

export function resolveTrackStreamFormat(track) {
  const direct =
    track?.streamFormat ||
    extensionFromPath(track?.finalPath) ||
    extensionFromPath(track?.src) ||
    extensionFromPath(track?.streamUrl) ||
    extensionFromPath(track?.preview_url);
  if (direct && FORMAT_BY_EXTENSION[direct]) return direct;
  return qualityToFormat(track?.quality);
}

export function getFormatLoadAttempts(track) {
  const primary = resolveTrackStreamFormat(track);
  const attempts = primary ? [primary] : [];
  for (const format of DEFAULT_FORMAT_ATTEMPTS) {
    if (!attempts.includes(format)) attempts.push(format);
  }
  return attempts;
}

export function getHowlerFormat(formatKey) {
  return FORMAT_BY_EXTENSION[formatKey] || [formatKey];
}

export function normalizeQueueTrack(track, overrides = {}) {
  const id = String(
    track?.id ?? track?.trackId ?? track?.mbid ?? overrides.id ?? "",
  );
  const src = track?.src ?? track?.streamUrl ?? track?.preview_url ?? "";
  return {
    id: id || `track-${crypto.randomUUID()}`,
    title: track?.title ?? track?.trackName ?? track?.name ?? "Unknown Track",
    artist: track?.artist ?? track?.artistName ?? overrides.artist ?? "",
    album: track?.album ?? track?.albumName ?? overrides.album ?? "",
    artwork: track?.artwork ?? track?.artworkUrl ?? overrides.artwork ?? null,
    src,
    streamFormat: resolveTrackStreamFormat(track),
    quality: track?.quality ?? overrides.quality ?? null,
    finalPath: track?.finalPath ?? overrides.finalPath ?? null,
    ...overrides,
  };
}

export function normalizeFlowTrack(track) {
  return normalizeQueueTrack({
    id: track.id,
    title: track.trackName,
    artist: track.artistName,
    album: track.albumName,
    src: track.streamUrl,
    finalPath: track.finalPath,
    streamFormat: track.streamFormat,
  });
}

export function normalizePreviewTrack(track, artistName, overrides = {}) {
  return normalizeQueueTrack(
    {
      id: track?.id ?? track?.mbid,
      title: track?.title,
      artist: artistName,
      src: track?.preview_url,
      quality: track?.quality,
    },
    overrides,
  );
}

export function getAudioLoadOptions(src, formatHint) {
  const hint = formatHint || extensionFromPath(src);
  if (hint && FORMAT_BY_EXTENSION[hint]) {
    return { format: FORMAT_BY_EXTENSION[hint] };
  }
  return { format: ["mp3"] };
}

export function isDownloadedLibraryAlbum(album, downloadStatuses = {}) {
  if (String(album?.id ?? "").startsWith("pending-")) return false;
  return (
    album?.monitored ||
    album?.statistics?.percentOfTracks > 0 ||
    album?.statistics?.sizeOnDisk > 0 ||
    !!downloadStatuses[album?.id]
  );
}
