import { userOps } from "../../db/helpers/index.js";
import { parseLastfmStation } from "./lastfmTracks.js";

const LASTFM_STATIONS = [
  { id: "library", name: "Library" },
  { id: "mix", name: "Mix" },
  { id: "recommended", name: "Recommended" },
];
const LASTFM_STATION_IDS = new Set(LASTFM_STATIONS.map((station) => station.id));
const LASTFM_STATION_URL = "https://www.last.fm/player/station/user";
const LASTFM_TIMEOUT_MS = 15000;

const invalidUsernameError = () => {
  const error = new Error("A valid Last.fm username is required");
  error.statusCode = 400;
  return error;
};

export function normalizeLastfmUsername(value) {
  const username = String(value || "").trim();
  if (!username || username.length > 100 || /[/?#\u0000-\u001f\u007f]/.test(username)) {
    throw invalidUsernameError();
  }
  return username;
}

export function normalizeLastfmStation(value) {
  const station = String(value || "").trim();
  if (!LASTFM_STATION_IDS.has(station)) {
    const error = new Error("Unsupported Last.fm station");
    error.statusCode = 400;
    throw error;
  }
  return station;
}

function resolveUsername(userId, requestedUsername) {
  const requested = String(requestedUsername || "").trim();
  if (requested) return normalizeLastfmUsername(requested);
  const user = userOps.getUserById(userId);
  if (user?.listenHistoryProvider === "lastfm" && user.listenHistoryUsername) {
    return normalizeLastfmUsername(user.listenHistoryUsername);
  }
  throw invalidUsernameError();
}

async function requestStation(username, stationId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LASTFM_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${LASTFM_STATION_URL}/${encodeURIComponent(username)}/${stationId}`,
      {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const error = new Error(`Last.fm station request failed (${response.status})`);
      error.statusCode = response.status >= 400 && response.status < 500 ? 404 : 502;
      throw error;
    }
    return parseLastfmStation(await response.json());
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Last.fm station request timed out");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const lastfmStationClient = {
  async listPlaylists(userId, requestedUsername) {
    const username = resolveUsername(userId, requestedUsername);
    const playlists = await Promise.all(
      LASTFM_STATIONS.map(async (station) => {
        const { tracks } = await requestStation(username, station.id);
        return {
          id: station.id,
          name: station.name,
          sourceType: "lastfm-station",
          trackCount: tracks.length,
        };
      }),
    );
    return { user: username, playlists };
  },

  async getStationTracks(userId, stationId, requestedUsername) {
    const username = resolveUsername(userId, requestedUsername);
    return {
      ...(await requestStation(username, normalizeLastfmStation(stationId))),
      user: username,
    };
  },
};
