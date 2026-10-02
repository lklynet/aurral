import {
  buildSharedTrackIdentity,
  dedupeSharedTracks,
} from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

const DEEZER_API_URL = "https://api.deezer.com";
const REQUEST_TIMEOUT_MS = 10_000;
const TRACK_PAGE_SIZE = 500;
const MAX_TRACKS = 2_000;
const SHELF_PLAYLISTS_PER_GENRE = 8;
const SHELF_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_RESULTS_PER_TAG = 25;
const PARTIAL_SHELF_TTL_MS = 15 * 60 * 1000;
const PLAYLIST_ID_PATTERN = /^\d{1,20}$/;
const DEEZER_NO_DATA_CODE = 800;
const DEEZER_QUOTA_CODE = 4;

export const EDITORIAL_GENRES = [
  { id: 0, name: "Popular" },
  { id: 132, name: "Pop" },
  { id: 116, name: "Rap/Hip Hop" },
  { id: 152, name: "Rock" },
  { id: 113, name: "Dance" },
  { id: 165, name: "R&B" },
  { id: 85, name: "Alternative" },
  { id: 106, name: "Electro" },
  { id: 129, name: "Jazz" },
  { id: 464, name: "Metal" },
];

let shelfCache = null;
let shelfRequest = null;
const tagSearchCache = new Map();

const providerError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export function validateDeezerPlaylistId(value) {
  const id = String(value ?? "").trim();
  if (PLAYLIST_ID_PATTERN.test(id)) return id;
  throw providerError("Enter a valid Deezer playlist", 400, "DEEZER_PLAYLIST_INVALID");
}

async function deezerRequest(path, params = {}) {
  const url = new URL(`${DEEZER_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw providerError("Deezer could not be reached", 502, "DEEZER_UNAVAILABLE");
  }
  if (response.status === 429) {
    throw providerError("Deezer is rate limiting requests; try again later", 429, "DEEZER_RATE_LIMITED");
  }
  if (!response.ok) {
    throw providerError(`Deezer request failed (${response.status})`, 502, "DEEZER_UNAVAILABLE");
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw providerError("Deezer returned an unreadable response", 502, "DEEZER_UNAVAILABLE");
  }
  if (body.error) {
    if (body.error.code === DEEZER_NO_DATA_CODE) {
      throw providerError("The Deezer playlist is unavailable", 404, "DEEZER_PLAYLIST_NOT_FOUND");
    }
    if (body.error.code === DEEZER_QUOTA_CODE) {
      throw providerError("Deezer is rate limiting requests; try again later", 429, "DEEZER_RATE_LIMITED");
    }
    throw providerError("Deezer returned an error", 502, "DEEZER_UNAVAILABLE");
  }
  return body;
}

const normalizePlaylistSummary = (playlist) => {
  const id = String(playlist?.id ?? "").trim();
  const name = String(playlist?.title || "").trim();
  if (!PLAYLIST_ID_PATTERN.test(id) || !name) return null;
  return {
    id,
    name,
    description: String(playlist?.description || "").trim() || null,
    trackCount: Number(playlist?.nb_tracks) || 0,
    artworkUrl: playlist?.picture_xl || playlist?.picture_big || null,
    curator: String(playlist?.user?.name || playlist?.creator?.name || "").trim() || null,
  };
};

const normalizeTracks = (rows) => {
  const stats = { sourceItems: rows.length, unavailable: 0, podcast: 0, incomplete: 0, duplicate: 0 };
  const excluded = [];
  const raw = [];
  const positions = [];
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    const artistName = String(row?.artist?.name || "").trim();
    const trackName = String(row?.title || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      excluded.push({ position, reason: "incomplete", trackName: trackName || null });
      continue;
    }
    raw.push({
      artistName,
      trackName,
      albumName: String(row?.album?.title || "").trim() || null,
      durationMs: Number(row?.duration) > 0 ? Number(row.duration) * 1000 : null,
      preview_url: row?.preview || null,
      artworkUrl: row?.album?.cover_medium || null,
      deezerAlbumId: row?.album?.id ? String(row.album.id) : null,
    });
    positions.push(position);
  }
  const seen = new Set();
  for (const [index, track] of raw.entries()) {
    const identity = buildSharedTrackIdentity(track);
    if (seen.has(identity)) {
      stats.duplicate += 1;
      excluded.push({
        position: positions[index],
        reason: "duplicate",
        artistName: track.artistName,
        trackName: track.trackName,
      });
    }
    seen.add(identity);
  }
  const deezerFields = new Map();
  for (const { preview_url, artworkUrl, deezerAlbumId, ...track } of raw) {
    const identity = buildSharedTrackIdentity(track);
    if (!deezerFields.has(identity)) {
      deezerFields.set(identity, { preview_url, artworkUrl, deezerAlbumId });
    }
  }
  const tracks = dedupeSharedTracks(raw).map((track) => ({
    ...track,
    ...deezerFields.get(buildSharedTrackIdentity(track)),
  }));
  excluded.sort((left, right) => left.position - right.position);
  return { tracks, stats, excluded };
};

export async function getDeezerPlaylist(value) {
  const id = validateDeezerPlaylistId(value);
  const summary = normalizePlaylistSummary(await deezerRequest(`/playlist/${id}`));
  if (!summary) {
    throw providerError("The Deezer playlist is unavailable", 404, "DEEZER_PLAYLIST_NOT_FOUND");
  }
  const rows = [];
  while (rows.length < MAX_TRACKS) {
    const page = await deezerRequest(`/playlist/${id}/tracks`, {
      index: rows.length,
      limit: TRACK_PAGE_SIZE,
    });
    const items = Array.isArray(page.data) ? page.data : [];
    rows.push(...items);
    if (items.length === 0 || !page.next) break;
  }
  return { ...summary, ...normalizeTracks(rows.slice(0, MAX_TRACKS)) };
}

async function loadShelf() {
  const results = await Promise.allSettled(
    EDITORIAL_GENRES.map((genre) =>
      deezerRequest(`/chart/${genre.id}/playlists`, { limit: SHELF_PLAYLISTS_PER_GENRE * 2 }),
    ),
  );
  if (results.every((result) => result.status === "rejected")) throw results[0].reason;
  const seen = new Set();
  const genres = [];
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue;
    const playlists = [];
    for (const entry of Array.isArray(result.value.data) ? result.value.data : []) {
      const playlist = normalizePlaylistSummary(entry);
      if (!playlist || seen.has(playlist.id)) continue;
      seen.add(playlist.id);
      playlists.push(playlist);
      if (playlists.length >= SHELF_PLAYLISTS_PER_GENRE) break;
    }
    if (playlists.length > 0) genres.push({ ...EDITORIAL_GENRES[index], playlists });
  }
  const complete = results.every((result) => result.status === "fulfilled");
  return { genres, ttlMs: complete ? SHELF_TTL_MS : PARTIAL_SHELF_TTL_MS };
}

export async function getEditorialShelf() {
  if (shelfCache && shelfCache.expiresAt > Date.now()) return shelfCache.genres;
  if (!shelfRequest) {
    shelfRequest = loadShelf()
      .then(({ genres, ttlMs }) => {
        shelfCache = { genres, expiresAt: Date.now() + ttlMs };
        return genres;
      })
      .catch((error) => {
        if (shelfCache) return shelfCache.genres;
        throw error;
      })
      .finally(() => {
        shelfRequest = null;
      });
  }
  return shelfRequest;
}

const isEditorPlaylist = (playlist) =>
  /deezer/i.test(String(playlist?.user?.name || playlist?.creator?.name || ""));

export async function searchEditorialPlaylists(tag) {
  const key = String(tag || "").trim().toLowerCase();
  if (!key) return [];
  const cached = tagSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.playlists;
  const body = await deezerRequest("/search/playlist", { q: key, limit: SEARCH_RESULTS_PER_TAG });
  const playlists = (Array.isArray(body.data) ? body.data : [])
    .filter(isEditorPlaylist)
    .map(normalizePlaylistSummary)
    .filter(Boolean);
  tagSearchCache.set(key, { playlists, expiresAt: Date.now() + SHELF_TTL_MS });
  return playlists;
}
