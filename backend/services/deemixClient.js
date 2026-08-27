import { dbOps } from "../db/helpers/index.js";
import { normalizeBaseUrl, normalizeInteger } from "./usenetClientCommon.js";
import axios from "../../lib/axiosFetch.js";

const FLAC_BITRATE = 9;
const BITRATE_OPTIONS = Object.freeze([
  Object.freeze({ value: "9", label: "FLAC" }),
  Object.freeze({ value: "3", label: "MP3 320" }),
  Object.freeze({ value: "1", label: "MP3 128" }),
]);

export const deemixSettings = Object.freeze({
  key: "deemix",
  label: "deemix",
  subtitle: "Deezer",
  enabledDefault: false,
  healthKey: "deemixConfigured",
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable deemix", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:6595",
      hint: "Sign in with your ARL in the deemix web UI first.",
    }),
    Object.freeze({
      key: "bitrate",
      label: "Bitrate",
      type: "select",
      section: "Downloads",
      options: BITRATE_OPTIONS,
    }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Downloads",
    }),
  ]),
  defaults: Object.freeze({ enabled: false, url: "", bitrate: FLAC_BITRATE, priority: 15 }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

function getSettings(config = null) {
  const deemix = config || dbOps.getSettings()?.integrations?.deemix || {};
  const bitrate = normalizeInteger(deemix.bitrate, FLAC_BITRATE);
  return {
    enabled: deemix.enabled === true,
    url: normalizeBaseUrl(deemix.url),
    bitrate: BITRATE_OPTIONS.some((option) => Number(option.value) === bitrate)
      ? bitrate
      : FLAC_BITRATE,
    priority: normalizeInteger(deemix.priority, 15),
  };
}

export function buildQueueUuid(trackId, bitrate) {
  return `track_${String(trackId || "").trim()}_${normalizeInteger(bitrate, FLAC_BITRATE)}`;
}

// deemix downloads exactly the configured bitrate, so unlike a Soulseek or
// Usenet release its quality tier is known before anything is downloaded.
// Deezer serves 16-bit FLAC, which classifies as flac-standard.
const BITRATE_TIERS = Object.freeze({ 9: "flac-standard", 3: "mp3-320", 1: "mp3-128" });

function bitrateLabel(bitrate) {
  const rate = normalizeInteger(bitrate, FLAC_BITRATE);
  return BITRATE_OPTIONS.find((option) => Number(option.value) === rate)?.label || String(rate);
}

// Deezer plans gate the higher bitrates, and deemix refuses the queue instead of
// downgrading. Name the setting to change rather than echoing its error id.
export function describeBitrateSupport(currentUser, bitrate) {
  const rate = normalizeInteger(bitrate, FLAC_BITRATE);
  if (rate === FLAC_BITRATE && currentUser?.can_stream_lossless === false) {
    return "This Deezer account cannot stream FLAC. Set Bitrate to MP3 320 or MP3 128.";
  }
  if (rate === 3 && currentUser?.can_stream_hq === false) {
    return "This Deezer account cannot stream MP3 320. Set Bitrate to MP3 128.";
  }
  return null;
}

function describeAddToQueueError(errid, currentUser, bitrate) {
  const id = String(errid || "").trim();
  if (id === "CantStream") {
    return (
      describeBitrateSupport(currentUser, bitrate) ||
      `This Deezer account cannot stream at ${bitrateLabel(bitrate)}. Lower the deemix bitrate.`
    );
  }
  if (id === "NotLoggedIn") {
    return "deemix is not logged in. Sign in with your ARL in the deemix web UI.";
  }
  return `deemix rejected the download: ${id || "unknown error"}`;
}

// deemix authenticates per express-session, so every call has to reuse the
// cookie that /api/connect issues.
// ponytail: one shared session, deemix runs single-user by default.
let session = { url: "", cookie: "" };
let connectionCache = { checkedAt: 0, result: null, url: null };

async function request(settings, method, path, { params, data, timeout = 30000 } = {}) {
  if (!settings.url) throw new Error("deemix URL is required");
  const response = await axios({
    method,
    url: `${settings.url}${path}`,
    params,
    data,
    timeout,
    headers: session.cookie ? { Cookie: session.cookie } : {},
  });
  const setCookie = response.headers?.["set-cookie"];
  if (setCookie) session.cookie = String(setCookie).split(";")[0];
  return response.data;
}

function isLoggedIn(connected) {
  return connected?.autologin === false;
}

async function connect(settings) {
  if (session.url !== settings.url) session = { url: settings.url, cookie: "" };
  const first = await request(settings, "GET", "/api/connect");
  const arl = String(first?.singleUser?.arl || "").trim();
  if (isLoggedIn(first) || !arl) return first;
  await request(settings, "POST", "/api/loginArl", { data: { arl }, timeout: 45000 });
  return request(settings, "GET", "/api/connect");
}

async function requireSession(settings) {
  const connected = await connect(settings);
  if (!isLoggedIn(connected)) {
    throw new Error("deemix is not logged in. Sign in with your ARL in the deemix web UI.");
  }
  return connected;
}

function normalizeTrack(entry) {
  const id = String(entry?.id || "").trim();
  if (!id) return null;
  return {
    id,
    title: String(entry?.title || "").trim(),
    artist: String(entry?.artist?.name || "").trim(),
    album: String(entry?.album?.title || "").trim(),
    durationSec: normalizeInteger(entry?.duration, 0),
    url: String(entry?.link || "").trim() || `https://www.deezer.com/track/${id}`,
    readable: entry?.readable !== false,
  };
}

export class DeemixClient {
  constructor(config = null) {
    this.key = "deemix";
    this.name = "deemix";
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

  isConfigured() {
    const { enabled, url } = this._getSettings();
    return enabled && !!url;
  }

  getStatus() {
    const settings = this._getSettings();
    const cached = connectionCache.url === settings.url ? connectionCache.result : null;
    return {
      enabled: settings.enabled,
      configured: this.isConfigured(),
      connected: cached?.connected === true,
    };
  }

  getBitrate() {
    return this._getSettings().bitrate;
  }

  getQualityTierId() {
    return BITRATE_TIERS[this._getSettings().bitrate] || null;
  }

  async testConnection({ force = false } = {}) {
    const settings = this._getSettings();
    if (!settings.enabled) {
      return { ok: false, configured: false, connected: false, message: "deemix is disabled" };
    }
    if (!settings.url) {
      return { ok: false, configured: false, connected: false, message: "deemix URL is required" };
    }
    if (
      !force &&
      connectionCache.url === settings.url &&
      connectionCache.result &&
      Date.now() - connectionCache.checkedAt < 30000
    ) {
      return connectionCache.result;
    }
    let result;
    try {
      const connected = await connect(settings);
      const version = String(connected?.update?.deemixVersion || "").trim();
      const suffix = version ? ` (v${version})` : "";
      if (connected?.deezerAvailable === false) {
        result = {
          ok: false,
          configured: true,
          connected: true,
          version,
          message: `deemix cannot reach Deezer${suffix}`,
        };
      } else if (!isLoggedIn(connected)) {
        result = {
          ok: false,
          configured: true,
          connected: true,
          version,
          message: `deemix is reachable${suffix} but not logged in. Sign in with your ARL in the deemix web UI.`,
        };
      } else {
        const user = String(connected?.currentUser?.name || "").trim();
        const unsupportedBitrate = describeBitrateSupport(
          connected?.currentUser,
          settings.bitrate,
        );
        const connectedMessage = `deemix is connected${user ? ` as ${user}` : ""}${suffix}`;
        result = {
          ok: true,
          warning: !!unsupportedBitrate,
          configured: true,
          connected: true,
          version,
          message: unsupportedBitrate
            ? `${connectedMessage}. ${unsupportedBitrate}`
            : connectedMessage,
        };
      }
    } catch (error) {
      result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach deemix",
      };
    }
    connectionCache = { checkedAt: Date.now(), result, url: settings.url };
    return result;
  }

  async search(query, { limit = 10 } = {}) {
    const term = String(query || "").trim();
    if (!term) return [];
    const settings = this._getSettings();
    await requireSession(settings);
    const data = await request(settings, "GET", "/api/search", {
      params: { term, type: "track", start: 0, nb: Math.min(Math.max(limit, 1), 50) },
      timeout: 45000,
    });
    if (data?.error) throw new Error(`deemix search failed: ${data.error}`);
    return (Array.isArray(data?.data) ? data.data : []).map(normalizeTrack).filter(Boolean);
  }

  async addToQueue(trackUrl, trackId) {
    const url = String(trackUrl || "").trim();
    if (!url) throw new Error("deemix download requires a Deezer track URL");
    const settings = this._getSettings();
    const connected = await requireSession(settings);
    const data = await request(settings, "POST", "/api/addToQueue", {
      data: { url, bitrate: settings.bitrate },
      timeout: 60000,
    });
    if (data?.result !== true) {
      throw new Error(
        describeAddToQueueError(data?.errid, connected?.currentUser, settings.bitrate),
      );
    }
    const queued = Array.isArray(data?.data?.obj) ? data.data.obj[0] : data?.data?.obj;
    // A track already in the queue comes back without an object, so fall back to
    // the uuid deemix derives from the track and bitrate.
    return String(queued?.uuid || "").trim() || buildQueueUuid(trackId, settings.bitrate);
  }

  async getQueueItem(uuid) {
    const id = String(uuid || "").trim();
    if (!id) return null;
    const settings = this._getSettings();
    const data = await request(settings, "GET", "/api/getQueue");
    return data?.queue?.[id] || null;
  }

  async removeFromQueue(uuid) {
    const id = String(uuid || "").trim();
    if (!id) return false;
    const settings = this._getSettings();
    await request(settings, "POST", "/api/removeFromQueue", { params: { uuid: id } });
    return true;
  }
}

export const deemixClient = new DeemixClient();
