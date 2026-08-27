import { dbOps } from "../db/helpers/index.js";
import {
  normalizeBaseUrl,
  normalizeInteger,
  sanitizeNzbName,
} from "./usenetClientCommon.js";
import axios from "../../lib/axiosFetch.js";

export const sabnzbdSettings = Object.freeze({
  key: "sabnzbd",
  label: "SABnzbd",
  subtitle: "Usenet",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable SABnzbd", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:8080",
    }),
    Object.freeze({
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      secret: true,
      section: "Connection",
    }),
    Object.freeze({ key: "category", label: "Category", type: "text", section: "Downloads" }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Downloads",
    }),
    Object.freeze({
      key: "addPaused",
      label: "Add NZBs paused",
      type: "toggle",
      section: "Advanced",
      advanced: true,
    }),
  ]),
  defaults: Object.freeze({
    enabled: false,
    url: "",
    apiKey: "",
    category: "aurral",
    priority: 20,
    addPaused: false,
  }),
  validation: Object.freeze({ required: ["url", "apiKey"], url: ["url"] }),
  testConnection: true,
});

let connectionCache = { checkedAt: 0, result: null, settingsKey: null };

function getSettings(config = null) {
  const sabnzbd = config || dbOps.getSettings()?.integrations?.sabnzbd || {};
  return {
    enabled: sabnzbd.enabled === true,
    url: normalizeBaseUrl(sabnzbd.url),
    apiKey: String(sabnzbd.apiKey || "").trim(),
    category: String(sabnzbd.category || "aurral").trim(),
    priority: normalizeInteger(sabnzbd.priority, 20),
    addPaused: sabnzbd.addPaused === true,
  };
}

function getSettingsKey(settings) {
  return JSON.stringify([settings.url, settings.apiKey]);
}

function buildUrl(url, apiKey) {
  const base = normalizeBaseUrl(url);
  if (!base) return "";
  return `${base}/api?apikey=${encodeURIComponent(apiKey)}&output=json`;
}

function mapPriority(addPaused) {
  if (addPaused) return -2;
  return 0;
}

function readConfigValue(entries, name) {
  const key = String(name || "").toLowerCase();
  if (Array.isArray(entries)) {
    const entry = entries.find(
      (item) => String(item?.name || "").toLowerCase() === key,
    );
    return entry?.value ?? "";
  }
  if (entries && typeof entries === "object") {
    for (const [k, v] of Object.entries(entries)) {
      if (String(k).toLowerCase() === key) return String(v ?? "");
    }
  }
  return "";
}

export class SabnzbdClient {
  constructor(config = null) {
    this.key = "sabnzbd";
    this.name = "SABnzbd";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this._config);
  }

  isConfigured() {
    const { enabled, url, apiKey } = this._getSettings();
    return enabled && !!url && !!apiKey;
  }

  getStatus() {
    const settings = this._getSettings();
    const cached =
      connectionCache.settingsKey === getSettingsKey(settings)
        ? connectionCache.result
        : null;
    return {
      enabled: settings.enabled,
      configured: this.isConfigured(),
      connected: cached?.connected === true,
      downloadPaused: cached?.downloadPaused === true,
    };
  }

  async api(mode, params = {}) {
    const settings = this._getSettings();
    const base = buildUrl(settings.url, settings.apiKey);
    const query = Object.entries({ mode, ...params })
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const response = await axios.get(`${base}&${query}`, { timeout: 45000 });
    if (response.status !== 200) {
      throw new Error(`SABnzbd ${mode} failed: HTTP ${response.status}`);
    }
    return response.data;
  }

  async appendUrl({
    name,
    url,
    category,
    priority,
    addPaused,
  }) {
    const settings = this._getSettings();
    const safeUrl = String(url || "").trim();
    if (!safeUrl) throw new Error("SABnzbd append requires a URL");
    const nzbName = `${sanitizeNzbName(name)}.nzb`;
    const pp = mapPriority(addPaused ?? settings.addPaused);
    const result = await this.api("addurl", {
      name: safeUrl,
      nzbname: nzbName,
      cat: category ?? settings.category,
      priority: normalizeInteger(priority, pp),
      pp: 3,
    });
    if (!result?.nzo_ids || result.nzo_ids.length === 0) {
      throw new Error("SABnzbd rejected the NZB URL");
    }
    return {
      nzbId: String(result.nzo_ids[0]),
      nzbName,
    };
  }

  async getQueueItem(nzoId) {
    const id = String(nzoId || "").trim();
    if (!id) return null;
    const result = await this.api("queue", { nzo_ids: id });
    const slots = result?.queue?.slots || [];
    return slots.find((s) => String(s.nzo_id) === id) || null;
  }

  async getHistoryItem(nzoId) {
    const id = String(nzoId || "").trim();
    if (!id) return null;
    const result = await this.api("history", { nzo_ids: id });
    const slots = result?.history?.slots || [];
    return slots.find((s) => String(s.nzo_id) === id) || null;
  }

  async deleteHistoryItem(nzoId) {
    const id = String(nzoId || "").trim();
    if (!id) return false;
    await this.api("history", { name: "delete", value: id, del_files: 1 }).catch(() => {});
    return true;
  }

  async getDownloadDirectories() {
    const result = await this.api("get_config", { section: "misc" }).catch(() => null);
    const entries = result?.config?.misc || [];
    return {
      completedPath: "",
      destDir: readConfigValue(entries, "complete_dir"),
      interDir: "",
      mainDir: "",
    };
  }

  async testConnection({ force = false } = {}) {
    const settings = this._getSettings();
    if (!settings.enabled) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "SABnzbd is disabled",
      };
    }
    if (!settings.url || !settings.apiKey) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "SABnzbd URL and API key are required",
      };
    }
    const settingsKey = getSettingsKey(settings);
    if (
      !force &&
      connectionCache.settingsKey === settingsKey &&
      connectionCache.result &&
      Date.now() - connectionCache.checkedAt < 30000
    ) {
      return connectionCache.result;
    }
    try {
      const apiUrl = buildUrl(settings.url, settings.apiKey);
      const [versionRes, statsRes, directories] = await Promise.all([
        axios.get(`${apiUrl}&mode=version`, { timeout: 15000 }),
        axios.get(`${apiUrl}&mode=server_stats`, { timeout: 15000 }),
        this.getDownloadDirectories(),
      ]);
      const version = versionRes.data?.version || null;
      const paused = statsRes.data?.paused === true;
      const rate = parseFloat(statsRes.data?.kbpersec || 0);
      const result = {
        ok: true,
        configured: true,
        connected: true,
        version,
        downloadPaused: paused,
        downloadRate: rate,
        downloadPath: directories.destDir || null,
        directories,
        message: `SABnzbd is connected${version ? ` (v${version})` : ""}`,
      };
      connectionCache = { checkedAt: Date.now(), result, settingsKey };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach SABnzbd",
      };
      connectionCache = { checkedAt: Date.now(), result, settingsKey };
      return result;
    }
  }
}

export const sabnzbdClient = new SabnzbdClient();
