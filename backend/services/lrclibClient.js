import { setTimeout as sleep } from "node:timers/promises";
import { dbOps } from "../db/helpers/index.js";
import { normalizeBaseUrl, normalizeInteger } from "./usenetClientCommon.js";
import { APP_VERSION } from "../config/constants.js";
import axios from "../../lib/axiosFetch.js";
import createCache from "./apiClients/simpleCache.js";
import createRateLimiter from "./apiClients/rateLimiter.js";
import { runSharedInflight } from "./sharedInflight.js";

const PUBLIC_INSTANCE = "https://lrclib.net";

// LRCLIB asks every client to identify itself so it can contact the maintainer
// about a misbehaving integration instead of blocking the whole instance.
const USER_AGENT = `Aurral/${APP_VERSION} (https://github.com/lklynet/aurral)`;

// LRCLIB is a free community service with no published quota that sheds load
// under bursts, so every Aurral instance spaces its own calls out rather than
// sending one request per lookup and waiting to be turned away.
const REQUEST_MIN_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_QUEUED_REQUESTS =
  Math.floor(REQUEST_TIMEOUT_MS / REQUEST_MIN_INTERVAL_MS) - 1;

// A track's lyrics barely change, but a track with none today may have some
// next week, so a miss is forgotten far sooner than a hit.
const HIT_TTL_SECONDS = 24 * 60 * 60;
const MISS_TTL_SECONDS = 60 * 60;
const CACHE_MAX_ENTRIES = 5000;

const lyricsCache = createCache(HIT_TTL_SECONDS, CACHE_MAX_ENTRIES);
const inflightLookups = new Map();
const requestLimiter = createRateLimiter(REQUEST_MIN_INTERVAL_MS, {
  maxQueue: MAX_QUEUED_REQUESTS,
});

// The server URL is part of the key so switching instances never serves an
// answer the new one did not give.
export function lyricsCacheKey(baseUrl, { artist, title, album, durationSec } = {}) {
  return [
    normalizeBaseUrl(baseUrl),
    String(artist || "").trim().toLowerCase(),
    String(title || "").trim().toLowerCase(),
    String(album || "").trim().toLowerCase(),
    normalizeInteger(durationSec, 0),
  ].join("|");
}

export function clearLyricsCache() {
  lyricsCache.flushAll();
  inflightLookups.clear();
}

export const lrclibSettings = Object.freeze({
  key: "lrclib",
  label: "LRCLIB",
  subtitle: "Community lyrics",
  enabledDefault: false,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable LRCLIB", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      section: "Connection",
      placeholder: PUBLIC_INSTANCE,
      hint: "Leave blank to use the public LRCLIB instance.",
    }),
    Object.freeze({
      key: "priority",
      label: "Provider priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Lyrics",
      hint: "Lower numbers are searched first.",
    }),
  ]),
  defaults: Object.freeze({ enabled: false, url: "", priority: 10 }),
  validation: Object.freeze({ required: [], url: ["url"] }),
  testConnection: true,
});

function getSettings(config = null) {
  const lrclib = config || dbOps.getSettings()?.integrations?.lrclib || {};
  return {
    enabled: lrclib.enabled === true,
    url: normalizeBaseUrl(lrclib.url) || PUBLIC_INSTANCE,
    priority: normalizeInteger(lrclib.priority, 10),
  };
}

function send(settings, path, { params, validateStatus } = {}) {
  return requestLimiter.schedule(
    (remainingMs) =>
      axios({
        method: "GET",
        url: `${settings.url}${path}`,
        params,
        timeout: Math.max(1000, Math.trunc(remainingMs ?? REQUEST_TIMEOUT_MS)),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        validateStatus,
      }),
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

// LRCLIB sheds load with a 503 that names how long to wait, so one retry turns
// a busy moment into an answer instead of a failed lookup.
// ponytail: one retry, add backoff if 503s ever arrive in bursts.
export function retryDelayMs(error) {
  if (error?.response?.status !== 503) return null;
  const retryAfter = Number(error.response.headers?.["retry-after"]);
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return 1000;
  return Math.min(retryAfter, 5) * 1000;
}

// The raw request error reads as a status code. LRCLIB explains itself in the
// response body, so report that instead.
export function describeError(error) {
  const message = String(error?.response?.data?.message || "").trim();
  return message ? new Error(`LRCLIB: ${message}`) : error;
}

async function request(settings, path, options = {}) {
  try {
    return await send(settings, path, options);
  } catch (error) {
    const delay = retryDelayMs(error);
    if (delay == null) throw describeError(error);
    await sleep(delay);
    try {
      return await send(settings, path, options);
    } catch (retryError) {
      throw describeError(retryError);
    }
  }
}

function normalizeEntry(entry) {
  const id = normalizeInteger(entry?.id, 0);
  if (!id) return null;
  const plain = String(entry?.plainLyrics || "").trim();
  const synced = String(entry?.syncedLyrics || "").trim();
  const instrumental = entry?.instrumental === true;
  if (!plain && !synced && !instrumental) return null;
  return {
    id,
    source: "lrclib",
    trackName: String(entry?.trackName || "").trim(),
    artistName: String(entry?.artistName || "").trim(),
    albumName: String(entry?.albumName || "").trim(),
    durationSec: normalizeInteger(entry?.duration, 0),
    instrumental,
    plain,
    synced,
  };
}

// A synced result is worth more than a plain one, so a search fallback should
// not settle for the first row when a later row carries timestamps.
export function bestMatch(entries) {
  const matches = (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  return matches.find((match) => match.synced) || matches[0] || null;
}

export class LrclibClient {
  constructor(config = null) {
    this.key = "lrclib";
    this.name = "LRCLIB";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this._config);
  }

  isEnabled() {
    return this._getSettings().enabled;
  }

  // LRCLIB needs no credentials, so an enabled provider is always usable — the
  // public instance stands in whenever no server URL is set.
  isConfigured() {
    return this.isEnabled();
  }

  getPriority() {
    return this._getSettings().priority;
  }

  getStatus() {
    const settings = this._getSettings();
    return {
      enabled: settings.enabled,
      configured: this.isConfigured(),
      url: settings.url,
    };
  }

  async testConnection() {
    const settings = this._getSettings();
    if (!settings.enabled) {
      return { ok: false, configured: false, message: "LRCLIB is disabled" };
    }
    try {
      const response = await request(settings, "/api/search", { params: { q: "aurral" } });
      if (!Array.isArray(response.data)) {
        return {
          ok: false,
          configured: true,
          message: `${settings.url} did not answer like an LRCLIB server`,
        };
      }
      return { ok: true, configured: true, message: `LRCLIB is reachable at ${settings.url}` };
    } catch (error) {
      return {
        ok: false,
        configured: true,
        message: error?.message || "Failed to reach LRCLIB",
      };
    }
  }

  async _lookup(settings, { artistName, trackName, album, durationSec }) {
    const duration = normalizeInteger(durationSec, 0);
    const exact = await request(settings, "/api/get", {
      params: {
        artist_name: artistName,
        track_name: trackName,
        album_name: String(album || "").trim() || undefined,
        duration: duration || undefined,
      },
      // A track LRCLIB has never seen is a 404, which is an answer, not a failure.
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (exact.status === 200) {
      const match = normalizeEntry(exact.data);
      if (match) return match;
    }

    const results = await request(settings, "/api/search", {
      params: { artist_name: artistName, track_name: trackName },
    });
    return bestMatch(results.data);
  }

  async getLyrics({ artist, title, album, durationSec } = {}) {
    const artistName = String(artist || "").trim();
    const trackName = String(title || "").trim();
    if (!artistName || !trackName) return null;
    const settings = this._getSettings();
    const key = lyricsCacheKey(settings.url, {
      artist: artistName,
      title: trackName,
      album,
      durationSec,
    });

    // A miss is cached as null, so undefined is the only "never asked" answer.
    const cached = lyricsCache.get(key);
    if (cached !== undefined) return cached;

    // Listeners playing the same track at once wait on one request, not several.
    return runSharedInflight(inflightLookups, key, async () => {
      const match = await this._lookup(settings, { artistName, trackName, album, durationSec });
      lyricsCache.set(key, match, match ? HIT_TTL_SECONDS : MISS_TTL_SECONDS);
      return match;
    });
  }
}

export const lrclibClient = new LrclibClient();
