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

function withEntryIds(state, tracks) {
  let nextEntryId = state.nextEntryId ?? 0;
  const entries = tracks.map((track) => ({ ...track, entryId: `q${nextEntryId++}` }));
  return [entries, nextEntryId];
}

function playbackEntries(state) {
  return state.playbackOrder.map((queueIndex) => state.queue[queueIndex]);
}

function currentEntryId(state) {
  return state.queue[state.playbackOrder[state.currentIndex]]?.entryId ?? null;
}

function upcomingPositions(state) {
  if (state.currentIndex < 0) return [];
  const positions = [];
  for (let index = state.currentIndex + 1; index < state.playbackOrder.length; index += 1) {
    positions.push(index);
  }
  if (state.repeatMode === "all") {
    for (let index = 0; index < state.currentIndex; index += 1) positions.push(index);
  }
  return positions;
}

export function getUpcomingTracks(state) {
  return upcomingPositions(state).map((index) => ({
    index,
    track: state.queue[state.playbackOrder[index]],
  }));
}

function arrange(state, queue, playback) {
  const current = currentEntryId(state);
  const naturalQueue = state.isShuffleEnabled ? queue : playback;
  const queueIndexById = new Map(naturalQueue.map((track, index) => [track.entryId, index]));
  return {
    ...state,
    queue: naturalQueue,
    playbackOrder: playback.map((track) => queueIndexById.get(track.entryId)),
    currentIndex: playback.findIndex((track) => track.entryId === current),
  };
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
  nextEntryId: 0,
};

export function shouldRestartTrack(state, position) {
  return position > RESTART_THRESHOLD_SECONDS || (state.currentIndex <= 0 && state.repeatMode !== "all");
}

export function queueReducer(state, action) {
  switch (action.type) {
    case "PLAY_QUEUE": {
      const { tracks, startTrackId, source } = action;
      if (!Array.isArray(tracks) || tracks.length === 0) return state;
      const shuffle = action.shuffle === true || state.isShuffleEnabled;
      const startQueueIndex = startTrackId == null
        ? -1
        : tracks.findIndex((track) => String(track.id) === String(startTrackId));
      const firstQueueIndex =
        startQueueIndex >= 0 ? startQueueIndex : action.shuffle === true ? null : 0;
      const playbackOrder = buildPlaybackOrder(tracks.length, shuffle, firstQueueIndex);
      const [queue, nextEntryId] = withEntryIds(state, tracks);
      return playAt(
        {
          ...state,
          queue,
          nextEntryId,
          playbackOrder,
          source: source ?? null,
          isShuffleEnabled: shuffle,
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
    case "REPLAY":
      if (state.currentIndex < 0) return state;
      return playAt(state, state.currentIndex, true);
    case "PREVIOUS": {
      if (state.queue.length === 0) return state;
      if (state.currentIndex > 0) return playAt(state, state.currentIndex - 1, true);
      if (state.repeatMode === "all") return playAt(state, state.playbackOrder.length - 1, true);
      return state;
    }
    case "INSERT_TRACKS": {
      const tracks = Array.isArray(action.tracks) ? action.tracks : [];
      if (tracks.length === 0) return state;
      if (state.currentIndex < 0 || state.queue.length === 0) {
        return queueReducer(state, { type: "PLAY_QUEUE", tracks, source: action.source ?? null });
      }
      const [entries, nextEntryId] = withEntryIds(state, tracks);
      const order = playbackEntries(state);
      const next = action.position === "next";
      const playbackAt = next ? state.currentIndex + 1 : order.length;
      const queueAt = next
        ? state.queue.findIndex((track) => track.entryId === currentEntryId(state)) + 1
        : state.queue.length;
      return {
        ...arrange(
          state,
          [...state.queue.slice(0, queueAt), ...entries, ...state.queue.slice(queueAt)],
          [...order.slice(0, playbackAt), ...entries, ...order.slice(playbackAt)],
        ),
        nextEntryId,
      };
    }
    case "REMOVE_ENTRY": {
      if (!action.entryId || action.entryId === currentEntryId(state)) return state;
      if (!state.queue.some((track) => track.entryId === action.entryId)) return state;
      const keep = (track) => track.entryId !== action.entryId;
      return arrange(state, state.queue.filter(keep), playbackEntries(state).filter(keep));
    }
    case "REORDER_UPCOMING": {
      const order = playbackEntries(state);
      const upcoming = upcomingPositions(state).map((index) => order[index]);
      const upcomingById = new Map(upcoming.map((track) => [track.entryId, track]));
      const entryIds = Array.isArray(action.entryIds) ? action.entryIds : [];
      if (
        entryIds.length !== upcoming.length ||
        new Set(entryIds).size !== entryIds.length ||
        !entryIds.every((entryId) => upcomingById.has(entryId))
      ) {
        return state;
      }
      const history = state.repeatMode === "all" ? [] : order.slice(0, state.currentIndex);
      return arrange(state, state.queue, [
        ...history,
        order[state.currentIndex],
        ...entryIds.map((entryId) => upcomingById.get(entryId)),
      ]);
    }
    case "CLEAR_UPCOMING": {
      const order = playbackEntries(state);
      const cleared = new Set(upcomingPositions(state).map((index) => order[index].entryId));
      if (cleared.size === 0) return state;
      const keep = (track) => !cleared.has(track.entryId);
      return arrange(state, state.queue.filter(keep), order.filter(keep));
    }
    case "RESTORE_ORDER": {
      const current = currentEntryId(state);
      const { queue, playbackOrder, isShuffleEnabled } = action;
      const currentIndex = playbackOrder.findIndex((queueIndex) => queue[queueIndex]?.entryId === current);
      if (current == null || currentIndex < 0) return state;
      return { ...state, queue, playbackOrder, isShuffleEnabled, currentIndex };
    }
    case "RESTORE_QUEUE": {
      if (state.currentIndex >= 0 || !Array.isArray(action.queue) || action.queue.length === 0) {
        return state;
      }
      const [queue, nextEntryId] = withEntryIds(state, action.queue);
      return playAt(
        {
          ...state,
          queue,
          nextEntryId,
          playbackOrder: action.playbackOrder,
          source: action.source ?? null,
          isShuffleEnabled: action.isShuffleEnabled === true,
          repeatMode: action.repeatMode ?? state.repeatMode,
        },
        action.currentIndex,
        false,
      );
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
      return {
        ...initialQueueState,
        isShuffleEnabled: state.isShuffleEnabled,
        repeatMode: state.repeatMode,
        nextEntryId: state.nextEntryId,
      };
    default:
      return state;
  }
}
