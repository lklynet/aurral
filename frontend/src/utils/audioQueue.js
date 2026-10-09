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
  const path = String(value || "")
    .split("?")[0]
    .toLowerCase();
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
  const id = String(track?.id ?? track?.trackId ?? track?.mbid ?? overrides.id ?? "");
  const src = track?.src ?? track?.streamUrl ?? track?.preview_url ?? "";
  const merged = {
    id: id || `track-${crypto.randomUUID()}`,
    title: track?.title ?? track?.trackName ?? track?.name ?? "Unknown Track",
    artist: track?.artist ?? track?.artistName ?? overrides.artist ?? "",
    album: track?.album ?? track?.albumName ?? overrides.album ?? "",
    artwork: track?.artwork ?? track?.artworkUrl ?? overrides.artwork ?? null,
    src,
    streamFormat: resolveTrackStreamFormat(track),
    quality: track?.quality ?? overrides.quality ?? null,
    finalPath: track?.finalPath ?? overrides.finalPath ?? null,
    durationMs: track?.durationMs ?? overrides.durationMs ?? null,
    recordHistory: track?.recordHistory === true || overrides.recordHistory === true,
    trackMbid: track?.trackMbid ?? overrides.trackMbid ?? null,
    ...overrides,
  };
  return {
    ...merged,
    artistMbid:
      String(merged.artistMbid ?? track?.artistMbid ?? track?.artistId ?? "").trim() || null,
    albumMbid:
      String(
        merged.albumMbid ?? track?.albumMbid ?? track?.releaseGroupMbid ?? track?.albumId ?? "",
      ).trim() || null,
    trackMbid: String(merged.trackMbid ?? "").trim() || null,
    recordHistory: merged.recordHistory === true,
  };
}

export function normalizePlaylistQueueTrack(track, overrides = {}) {
  return normalizeQueueTrack({
    id: track.id,
    title: track.trackName,
    artist: track.artistName,
    album: track.albumName,
    artwork: track.artworkUrl || track.coverUrl || null,
    src: track.streamUrl,
    finalPath: track.finalPath,
    streamFormat: track.streamFormat,
    artistMbid: track.artistMbid,
    albumMbid: track.albumMbid,
    trackMbid: track.trackMbid || track.mbid,
    durationMs: track.durationMs,
    recordHistory: track?.recordHistory !== false,
  }, overrides);
}

export function normalizePreviewTrack(track, artistName, overrides = {}) {
  return normalizeQueueTrack(
    {
      id: track?.id ?? track?.mbid,
      title: track?.title,
      artist: artistName,
      src: track?.preview_url,
      artwork: track?.artwork ?? track?.artworkUrl,
      quality: track?.quality,
      artistMbid: track?.artistMbid ?? track?.artistId,
      albumMbid: track?.albumMbid ?? track?.releaseGroupMbid,
    },
    overrides,
  );
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

const RESTART_THRESHOLD_SECONDS = 3;

function shuffleIndices(indices) {
  const shuffled = [...indices];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function buildPlaybackOrder(trackCount, shuffle, firstQueueIndex) {
  const indices = Array.from({ length: trackCount }, (_, index) => index);
  if (!shuffle) return indices;
  if (firstQueueIndex == null) return shuffleIndices(indices);
  return [firstQueueIndex, ...shuffleIndices(indices.filter((index) => index !== firstQueueIndex))];
}

function playAt(state, index, autoplay) {
  return {
    ...state,
    currentIndex: index,
    autoplay,
    error: null,
    queueRevision: state.queueRevision + 1,
  };
}

export const initialQueueState = {
  queue: [],
  currentIndex: -1,
  source: null,
  error: null,
  isShuffleEnabled: false,
  playbackOrder: [],
  repeatMode: "off",
  autoplay: true,
  queueRevision: 0,
};

export function shouldRestartTrack(state, position) {
  return position > RESTART_THRESHOLD_SECONDS || (state.currentIndex <= 0 && state.repeatMode !== "all");
}

export function queueReducer(state, action) {
  switch (action.type) {
    case "PLAY_QUEUE": {
      const { tracks, startTrackId, shuffle, updateShufflePreference, source } = action;
      if (!Array.isArray(tracks) || tracks.length === 0) return state;
      const startQueueIndex = startTrackId == null
        ? -1
        : tracks.findIndex((track) => String(track.id) === String(startTrackId));
      const firstQueueIndex = startQueueIndex >= 0 ? startQueueIndex : null;
      const playbackOrder = buildPlaybackOrder(tracks.length, shuffle, firstQueueIndex);
      return playAt(
        {
          ...state,
          queue: tracks,
          playbackOrder,
          source: source ?? null,
          isShuffleEnabled: updateShufflePreference ? shuffle : state.isShuffleEnabled,
        },
        shuffle ? 0 : firstQueueIndex ?? 0,
        true,
      );
    }
    case "SET_ALBUM_ARTWORK": {
      let changed = false;
      const queue = state.queue.map((track) => {
        if (track.artwork || track.albumMbid !== action.albumMbid) return track;
        changed = true;
        return { ...track, artwork: action.artwork };
      });
      return changed ? { ...state, queue } : state;
    }
    case "SKIP_TO":
      if (action.index < 0 || action.index >= state.playbackOrder.length) return state;
      return playAt(state, action.index, true);
    case "NEXT": {
      if (state.queue.length === 0) return state;
      const nextIndex = state.currentIndex + 1;
      if (nextIndex < state.playbackOrder.length) return playAt(state, nextIndex, true);
      return playAt(state, 0, state.repeatMode === "all");
    }
    case "PREVIOUS": {
      if (state.queue.length === 0) return state;
      if (state.currentIndex > 0) return playAt(state, state.currentIndex - 1, true);
      if (state.repeatMode === "all") return playAt(state, state.playbackOrder.length - 1, true);
      return state;
    }
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SHUFFLE": {
      if (state.queue.length === 0 || state.currentIndex < 0) {
        return { ...state, isShuffleEnabled: action.enabled };
      }
      const currentQueueIndex = state.playbackOrder[state.currentIndex];
      return {
        ...state,
        isShuffleEnabled: action.enabled,
        playbackOrder: buildPlaybackOrder(state.queue.length, action.enabled, currentQueueIndex),
        currentIndex: action.enabled ? 0 : currentQueueIndex,
      };
    }
    case "TOGGLE_REPEAT": {
      const modes = ["off", "all", "one"];
      const nextMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
      return { ...state, repeatMode: nextMode };
    }
    case "CLEAR_QUEUE":
      return initialQueueState;
    default:
      return state;
  }
}
