import { listenbrainzRequest } from "../apiClients/listenbrainz.js";
import { LISTENBRAINZ_API } from "../../config/constants.js";
import { scrobbleConnectionStore } from "../scrobbleConnectionStore.js";
import { parseListenBrainzPlaylist } from "./listenbrainzTracks.js";

const PLAYLIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist";
const GENERATED_PLAYLIST_TYPES = ["weekly-jams", "weekly-exploration"];
const GENERATED_PLAYLIST_NAMES = {
  "weekly-jams": "Weekly Jams",
  "weekly-exploration": "Weekly Exploration",
};

const getConnection = (userId) => {
  const connection = scrobbleConnectionStore.getConnection(userId, "listenbrainz");
  if (connection) return connection;
  const error = new Error("ListenBrainz is not connected");
  error.statusCode = 401;
  throw error;
};

const unwrapPlaylist = (entry) =>
  entry?.playlist && typeof entry.playlist === "object" ? entry.playlist : entry;

const getPlaylistId = (playlist) => {
  const identifier = String(playlist?.identifier || "").trim();
  const match = identifier.match(/\/playlist\/([^/]+)\/?$/i);
  return match?.[1] || "";
};

const getGeneratedPlaylistType = (playlist) => {
  const sourcePatch = String(
    playlist?.extension?.[PLAYLIST_EXTENSION]?.additional_metadata?.algorithm_metadata
      ?.source_patch || "",
  ).trim().toLowerCase();
  return GENERATED_PLAYLIST_TYPES.includes(sourcePatch) ? sourcePatch : null;
};

const getPlaylistTimestamp = (playlist) => {
  const value =
    playlist?.date || playlist?.extension?.[PLAYLIST_EXTENSION]?.last_modified_at || "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const validatePlaylistId = (playlistId) => {
  const id = String(playlistId || "").trim();
  if (PLAYLIST_ID_PATTERN.test(id)) return id;
  const error = new Error("A valid ListenBrainz playlist ID is required");
  error.statusCode = 400;
  throw error;
};

const fetchPlaylistPages = async ({ username, token, path }) => {
  const count = 100;
  const playlists = [];
  let offset = 0;
  let playlistCount = null;
  do {
    const payload = await listenbrainzRequest(
      `/1/user/${encodeURIComponent(username)}/playlists${path}`,
      { count, offset },
      { token, baseUrl: LISTENBRAINZ_API },
    );
    const page = Array.isArray(payload?.playlists) ? payload.playlists : [];
    playlists.push(...page);
    offset += page.length;
    playlistCount = Number.isFinite(Number(payload?.playlist_count))
      ? Number(payload.playlist_count)
      : null;
    if (!page.length) break;
    if (playlistCount == null && page.length < count) break;
  } while (playlistCount == null || offset < playlistCount);
  return playlists;
};

const fetchPlaylistTrackCount = async ({ playlistId, token }) => {
  const payload = await listenbrainzRequest(
    `/1/playlist/${encodeURIComponent(playlistId)}`,
    { fetch_metadata: false },
    { token, baseUrl: LISTENBRAINZ_API },
  );
  const playlist = unwrapPlaylist(payload);
  return Array.isArray(playlist?.track) ? playlist.track.length : null;
};

const getLatestGeneratedPlaylists = (entries) => {
  const latest = new Map();
  for (const entry of entries) {
    const playlist = unwrapPlaylist(entry);
    const sourceType = getGeneratedPlaylistType(playlist);
    const id = getPlaylistId(playlist);
    if (!sourceType || !id) continue;
    const candidate = {
      id,
      name: GENERATED_PLAYLIST_NAMES[sourceType],
      sourceType,
      trackCount:
        Array.isArray(playlist?.track) && playlist.track.length > 0
          ? playlist.track.length
          : null,
      timestamp: getPlaylistTimestamp(playlist),
    };
    const previous = latest.get(sourceType);
    if (!previous || candidate.timestamp > previous.timestamp) {
      latest.set(sourceType, candidate);
    }
  }
  return GENERATED_PLAYLIST_TYPES
    .map((sourceType) => latest.get(sourceType))
    .filter(Boolean)
    .map(({ timestamp: _timestamp, ...playlist }) => playlist);
};

const getGeneratedPlaylistTypeOrThrow = (value) => {
  const sourceType = String(value || "").trim().toLowerCase();
  if (GENERATED_PLAYLIST_TYPES.includes(sourceType)) return sourceType;
  const error = new Error("A valid ListenBrainz generated playlist type is required");
  error.statusCode = 400;
  throw error;
};

export const listenbrainzPlaylistClient = {
  async listPlaylists(userId) {
    const connection = getConnection(userId);
    const username = String(connection.displayName || "").trim();
    if (!username) {
      const error = new Error("ListenBrainz connection has no username");
      error.statusCode = 502;
      throw error;
    }

    const playlists = await fetchPlaylistPages({ username, token: connection.token, path: "" });
    const generatedPlaylists = getLatestGeneratedPlaylists(
      await fetchPlaylistPages({ username, token: connection.token, path: "/createdfor" }),
    );

    const normalizedPlaylists = new Map();
    for (const entry of playlists) {
      const playlist = unwrapPlaylist(entry);
      const normalized = {
        id: getPlaylistId(playlist),
        name: String(playlist?.title || "").trim(),
        trackCount:
          Array.isArray(playlist?.track) && playlist.track.length > 0
            ? playlist.track.length
            : null,
      };
      if (normalized.id && normalized.name && !normalizedPlaylists.has(normalized.id)) {
        normalizedPlaylists.set(normalized.id, normalized);
      }
    }
    for (const playlist of generatedPlaylists) {
      if (playlist.id && playlist.name && !normalizedPlaylists.has(playlist.id)) {
        normalizedPlaylists.set(playlist.id, playlist);
      }
    }
    const playlistsWithCounts = await Promise.all(
      [...normalizedPlaylists.values()].map(async (playlist) => {
        if (playlist.trackCount != null) return playlist;
        try {
          return {
            ...playlist,
            trackCount: await fetchPlaylistTrackCount({
              playlistId: playlist.id,
              token: connection.token,
            }),
          };
        } catch {
          return playlist;
        }
      }),
    );
    return {
      user: username,
      playlists: playlistsWithCounts,
    };
  },

  async getGeneratedPlaylistTracks(userId, sourceType) {
    const connection = getConnection(userId);
    const username = String(connection.displayName || "").trim();
    if (!username) {
      const error = new Error("ListenBrainz connection has no username");
      error.statusCode = 502;
      throw error;
    }
    const type = getGeneratedPlaylistTypeOrThrow(sourceType);
    const entries = await fetchPlaylistPages({
      username,
      token: connection.token,
      path: "/createdfor",
    });
    const playlist = getLatestGeneratedPlaylists(entries).find(
      (candidate) => candidate.sourceType === type,
    );
    if (!playlist) {
      const error = new Error(`No current ListenBrainz ${type} playlist was found`);
      error.statusCode = 404;
      throw error;
    }
    return this.getPlaylistTracks(userId, playlist.id);
  },

  async getPlaylistTracks(userId, playlistId) {
    const connection = getConnection(userId);
    const id = validatePlaylistId(playlistId);
    const payload = await listenbrainzRequest(
      `/1/playlist/${encodeURIComponent(id)}`,
      {},
      { token: connection.token, baseUrl: LISTENBRAINZ_API },
    );
    return parseListenBrainzPlaylist(payload);
  },
};
