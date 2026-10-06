import { dbOps } from "../db/helpers/index.js";
import {
  normalizeBaseUrl,
  normalizeInteger,
  sanitizeNzbName,
} from "./usenetClientCommon.js";
import axios from "../../lib/axiosFetch.js";
import { removeNzbgetDownloadFolder } from "./nzbgetCleanup.js";

export const nzbgetSettings = Object.freeze({
  key: "nzbget",
  label: "NZBGet",
  subtitle: "Usenet",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable NZBGet", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:6789",
    }),
    Object.freeze({
      key: "username",
      label: "Username",
      type: "text",
      section: "Connection",
    }),
    Object.freeze({
      key: "password",
      label: "Password",
      type: "password",
      secret: true,
      section: "Connection",
    }),
    Object.freeze({ key: "category", label: "Category", type: "text", section: "Downloads" }),
    Object.freeze({
      key: "deleteLeftovers",
      label: "Delete leftover files",
      type: "toggle",
      section: "Downloads",
    }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Downloads",
    }),
    Object.freeze({
      key: "nzbPriority",
      label: "NZB priority",
      type: "number",
      min: -100,
      max: 900,
      section: "Advanced",
      advanced: true,
    }),
    Object.freeze({
      key: "completedPath",
      label: "Completed download path",
      type: "text",
      section: "Advanced",
      advanced: true,
      placeholder: "/downloads/completed",
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
    username: "",
    password: "",
    category: "aurral",
    deleteLeftovers: true,
    priority: 20,
    nzbPriority: 0,
    addPaused: false,
    completedPath: "",
  }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

let connectionCache = { checkedAt: 0, result: null, settingsKey: null };
let folderCleanup = Promise.resolve();

function getSettings(config = null) {
  const nzbget = config || dbOps.getSettings()?.integrations?.nzbget || {};
  return {
    enabled: nzbget.enabled === true,
    url: normalizeBaseUrl(nzbget.url),
    username: String(nzbget.username || "").trim(),
    password: String(nzbget.password || ""),
    category: String(nzbget.category || "aurral").trim(),
    deleteLeftovers: nzbget.deleteLeftovers !== false,
    priority: normalizeInteger(nzbget.priority, 20),
    nzbPriority: normalizeInteger(nzbget.nzbPriority, 0),
    addPaused: nzbget.addPaused === true,
    completedPath: String(nzbget.completedPath || "").trim(),
  };
}

function getSettingsKey(settings) {
  return JSON.stringify([settings.url, settings.username, settings.password]);
}

function buildRpcUrl(baseUrl) {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return "";
  if (/\/jsonrpc$/i.test(url)) return url;
  return `${url}/jsonrpc`;
}

function buildAuthFromCredentials(username, password) {
  if (!username && !password) return undefined;
  return { username, password };
}

function readConfigValue(configEntries, name) {
  const key = String(name || "").toLowerCase();
  const entry = (Array.isArray(configEntries) ? configEntries : []).find(
    (item) => String(item?.Name || item?.name || "").toLowerCase() === key,
  );
  return entry?.Value ?? entry?.value ?? "";
}

export class NzbgetClient {
  constructor(config = null) {
    this.key = "nzbget";
    this.name = "NZBGet";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this._config);
  }

  isConfigured() {
    const { enabled, url } = this._getSettings();
    return enabled && !!url;
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
      downloadPath: cached?.downloadPath || settings.completedPath || null,
    };
  }

  async rpc(method, params = []) {
    const { url, username, password } = this._getSettings();
    const rpcUrl = buildRpcUrl(url);
    if (!rpcUrl) throw new Error("NZBGet not configured");
    const response = await axios.post(
      rpcUrl,
      {
        jsonrpc: "2.0",
        method,
        params,
        id: Date.now(),
      },
      {
        timeout: 45000,
        auth: buildAuthFromCredentials(username, password),
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (response.status !== 200) {
      throw new Error(`NZBGet ${method} failed: HTTP ${response.status}`);
    }
    if (response.data?.error) {
      const message =
        response.data.error.message ||
        response.data.error.Message ||
        JSON.stringify(response.data.error);
      throw new Error(`NZBGet ${method} failed: ${message}`);
    }
    return response.data?.result;
  }

  async version() {
    return this.rpc("version", []);
  }

  async status() {
    return this.rpc("status", []);
  }

  async config() {
    return this.rpc("config", []);
  }

  async listGroups() {
    const result = await this.rpc("listgroups", [0]);
    return Array.isArray(result) ? result : [];
  }

  async history(includeHidden = false) {
    const result = await this.rpc("history", [includeHidden === true]);
    return Array.isArray(result) ? result : [];
  }

  async appendUrl({
    name,
    url,
    category,
    priority,
    addToTop = false,
    addPaused,
    dupeKey = "",
    dupeScore = 0,
    dupeMode = "FORCE",
    autoCategory = false,
    ppParameters = [],
  }) {
    const settings = this._getSettings();
    const safeUrl = String(url || "").trim();
    if (!safeUrl) throw new Error("NZBGet append requires a URL");
    const nzbName = `${sanitizeNzbName(name)}.nzb`;
    const result = await this.rpc("append", [
      nzbName,
      safeUrl,
      category ?? settings.category,
      normalizeInteger(priority, settings.nzbPriority),
      addToTop === true,
      addPaused ?? settings.addPaused,
      String(dupeKey || ""),
      normalizeInteger(dupeScore, 0),
      String(dupeMode || "FORCE"),
      autoCategory === true,
      Array.isArray(ppParameters) ? ppParameters : [],
    ]);
    const nzbId = normalizeInteger(result, 0);
    if (nzbId <= 0) {
      throw new Error("NZBGet rejected the NZB URL");
    }
    return {
      nzbId,
      nzbName,
    };
  }

  async getQueueItem(nzbId) {
    const id = normalizeInteger(nzbId, null);
    if (id == null) return null;
    const groups = await this.listGroups();
    return groups.find((group) => normalizeInteger(group?.NZBID, null) === id) || null;
  }

  async getHistoryItem(nzbId) {
    const id = normalizeInteger(nzbId, null);
    if (id == null) return null;
    const items = await this.history(false);
    return items.find((item) => normalizeInteger(item?.NZBID ?? item?.ID, null) === id) || null;
  }

  async deleteQueueItem(nzbId) {
    return this.editItem("GroupFinalDelete", nzbId);
  }

  // NZBGet keeps a finished download's files, so Aurral deletes its folder
  // first. If that fails, the history entry stays for a manual cleanup.
  // Cleanups run one at a time so two downloads that share a folder cannot
  // each leave it to the other.
  async deleteHistoryItem(nzbId, { deleteFiles = false, historyItem = null } = {}) {
    const settings = this._getSettings();
    if (!deleteFiles || !settings.deleteLeftovers) return this.editItem("HistoryFinalDelete", nzbId);
    const cleanup = folderCleanup.then(async () => {
      const item = historyItem || (await this.getHistoryItem(nzbId));
      if (item && !(await this.sharesDownloadFolder(item))) {
        await removeNzbgetDownloadFolder(item, await this.getDownloadDirectories(), settings.category);
      }
      return this.editItem("HistoryFinalDelete", nzbId);
    });
    folderCleanup = cleanup.catch(() => {});
    return cleanup;
  }

  // NZBGet moves a download into the folder named after it even when another
  // download of the same name already uses that folder. The last one removes it.
  async sharesDownloadFolder(item) {
    const id = normalizeInteger(item.NZBID ?? item.ID, null);
    const isOther = (entry) => normalizeInteger(entry?.NZBID ?? entry?.ID, null) !== id;
    const [queue, history] = await Promise.all([this.listGroups(), this.history(false)]);
    return queue.some((entry) => isOther(entry) && entry.NZBName === item.NZBName)
      || history.some((entry) => isOther(entry) && entry.DestDir === item.DestDir);
  }

  async editItem(command, nzbId) {
    const id = normalizeInteger(nzbId, 0);
    if (id <= 0) return false;
    return (await this.rpc("editqueue", [command, "", [id]])) === true;
  }

  async getDownloadDirectories() {
    const settings = this._getSettings();
    const config = await this.config().catch(() => []);
    const categoryEntry = config.find((entry) =>
      /^Category\d+\.Name$/i.test(entry.Name || "")
      && String(entry.Value || "").toLowerCase() === settings.category.toLowerCase());
    return {
      completedPath: settings.completedPath || "",
      categoryDestDir: categoryEntry
        ? readConfigValue(config, categoryEntry.Name.replace(/\.Name$/i, ".DestDir"))
        : "",
      destDir: readConfigValue(config, "DestDir"),
      interDir: readConfigValue(config, "InterDir"),
      mainDir: readConfigValue(config, "MainDir"),
    };
  }

  async testConnection({ force = false } = {}) {
    const settings = this._getSettings();
    if (!settings.enabled) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "NZBGet is disabled",
      };
    }
    if (!settings.url) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "NZBGet URL is required",
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
      const [version, status, directories] = await Promise.all([
        this.version(),
        this.status(),
        this.getDownloadDirectories(),
      ]);
      const result = {
        ok: true,
        configured: true,
        connected: true,
        version,
        downloadPaused: status?.DownloadPaused === true,
        downloadRate: Number(status?.DownloadRateLo ?? status?.DownloadRate ?? 0),
        downloadPath: directories.completedPath || directories.destDir || null,
        directories,
        message: `NZBGet is connected${version ? ` (v${version})` : ""}`,
      };
      connectionCache = { checkedAt: Date.now(), result, settingsKey };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        connected: false,
        message: error?.message || "Failed to reach NZBGet",
      };
      connectionCache = { checkedAt: Date.now(), result, settingsKey };
      return result;
    }
  }
}

export const nzbgetClient = new NzbgetClient();
