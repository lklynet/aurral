import { randomUUID } from "node:crypto";
import { dbOps } from "../db/helpers/index.ts";
import { normalizeBaseUrl, normalizeInteger, sanitizeNzbName } from "./usenetClientCommon.ts";
import axios from "../../lib/axiosFetch.ts";
import { removeSabnzbdDownloadFolder } from "./sabnzbdCleanup.ts";
import { asAppError } from "../../lib/errors.ts";

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
    deleteLeftovers: true,
    priority: 20,
    addPaused: false,
  }),
  validation: Object.freeze({ required: ["url", "apiKey"], url: ["url"] }),
  testConnection: true,
});

export const tidarrSettings = Object.freeze({
  key: "tidarr",
  label: "Tidarr",
  subtitle: "Tidal",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable Tidarr", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:8484",
    }),
    Object.freeze({
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      secret: true,
      section: "Connection",
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
  defaults: Object.freeze({
    enabled: false,
    url: "",
    apiKey: "",
    priority: 20,
  }),
  validation: Object.freeze({ required: ["url", "apiKey"], url: ["url"] }),
  testConnection: true,
});

const SABNZBD_API_CLIENTS = {
  sabnzbd: { name: "SABnzbd", apiPath: "/api" },
  tidarr: { name: "Tidarr", apiPath: "/api/sabnzbd/api" },
} as const;

type SabnzbdApiClientKey = keyof typeof SABNZBD_API_CLIENTS;

type SabnzbdConfig = {
  enabled?: boolean;
  url?: string | null;
  apiKey?: string | null;
  category?: string | null;
  priority?: number | string | null;
  addPaused?: boolean;
  deleteLeftovers?: boolean;
};

type SabnzbdConnection = {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  message: string;
  version?: string | null;
  downloadPath?: string | null;
  directories?: Awaited<ReturnType<SabnzbdClient["getDownloadDirectories"]>>;
};

type SabnzbdSlot = { nzo_id: string; storage?: string | null };
type NzbId = string | number | null | undefined;

const connectionCache = new Map<
  SabnzbdApiClientKey,
  { checkedAt: number; result: SabnzbdConnection; settingsKey: string }
>();
let folderCleanup: Promise<unknown> = Promise.resolve();

function normalizeStoragePath(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function getSettings(key: SabnzbdApiClientKey, config: SabnzbdConfig | null = null) {
  const sabnzbd: SabnzbdConfig = config || dbOps.getSettings()?.integrations?.[key] || {};
  return {
    enabled: sabnzbd.enabled === true,
    url: normalizeBaseUrl(sabnzbd.url),
    apiKey: String(sabnzbd.apiKey || "").trim(),
    category: String(sabnzbd.category || "aurral").trim(),
    deleteLeftovers: sabnzbd.deleteLeftovers !== false,
    priority: normalizeInteger(sabnzbd.priority, 20),
    addPaused: sabnzbd.addPaused === true,
  };
}

function getSettingsKey(settings: { url: string; apiKey: string }) {
  return JSON.stringify([settings.url, settings.apiKey]);
}

function buildUrl(url: string | null | undefined, apiPath: string, apiKey: string) {
  const base = normalizeBaseUrl(url);
  if (!base) return "";
  return `${base}${apiPath}?apikey=${encodeURIComponent(apiKey)}&output=json`;
}

function buildNzbUpload(fileName: string, content: Buffer) {
  const boundary = `aurral-${randomUUID()}`;
  const header =
    `--${boundary}\r\nContent-Disposition: form-data; name="name"; ` +
    `filename="${fileName.replace(/"/g, "")}"\r\nContent-Type: application/x-nzb\r\n\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(header),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function readConfigValue(entries: unknown, name: string) {
  const key = String(name || "").toLowerCase();
  if (Array.isArray(entries)) {
    const entry = entries.find((item) => String(item?.name || "").toLowerCase() === key);
    return entry?.value ?? "";
  }
  if (entries && typeof entries === "object") {
    for (const [k, v] of Object.entries(entries)) {
      if (String(k).toLowerCase() === key) return String(v ?? "");
    }
  }
  return "";
}

function readCategoryDirectory(entries: unknown, category: unknown) {
  const wanted = String(category || "")
    .trim()
    .toLowerCase();
  if (!wanted) return "";
  const categories = Array.isArray(entries)
    ? entries
    : entries && typeof entries === "object"
      ? Object.values(entries)
      : [];
  const match = categories.find(
    (entry: { name?: unknown; dir?: unknown } | null | undefined) =>
      String(entry?.name || "")
        .trim()
        .toLowerCase() === wanted,
  );
  return String(match?.dir || "").trim();
}

export class SabnzbdClient {
  declare key: SabnzbdApiClientKey;
  declare name: string;
  declare apiPath: string;
  declare _config: SabnzbdConfig | null;

  constructor(config: SabnzbdConfig | null = null, key: SabnzbdApiClientKey = "sabnzbd") {
    this.key = key;
    this.name = SABNZBD_API_CLIENTS[key].name;
    this.apiPath = SABNZBD_API_CLIENTS[key].apiPath;
    this._config = config;
  }

  updateConfig(config: SabnzbdConfig | null = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this.key, this._config);
  }

  _apiUrl() {
    const settings = this._getSettings();
    return buildUrl(settings.url, this.apiPath, settings.apiKey);
  }

  isConfigured() {
    const { enabled, url, apiKey } = this._getSettings();
    return enabled && !!url && !!apiKey;
  }

  getStatus() {
    const settings = this._getSettings();
    const cached = connectionCache.get(this.key);
    return {
      enabled: settings.enabled,
      configured: this.isConfigured(),
      connected: cached?.settingsKey === getSettingsKey(settings) && cached.result.connected,
    };
  }

  async api(
    mode: string,
    params: Record<string, string | number | null | undefined> = {},
    { file = null }: { file?: ReturnType<typeof buildNzbUpload> | null } = {},
  ) {
    const base = this._apiUrl();
    const query = Object.entries({ mode, ...params })
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const response = file
      ? await axios.post(`${base}&${query}`, file.body, {
          timeout: 45000,
          headers: { "Content-Type": file.contentType },
        })
      : await axios.get(`${base}&${query}`, { timeout: 45000 });
    if (response.status !== 200) {
      throw new Error(`${this.name} ${mode} failed: HTTP ${response.status}`);
    }
    return response.data;
  }

  async appendNzb({
    name,
    content,
    category,
    addPaused,
  }: {
    name: string | undefined;
    content: Buffer | null | undefined;
    category?: string | null;
    addPaused?: boolean | null;
  }) {
    const settings = this._getSettings();
    if (!content?.length) throw new Error(`${this.name} append requires an NZB file`);
    const nzbName = `${sanitizeNzbName(name)}.nzb`;
    const result = await this.api(
      "addfile",
      {
        nzbname: nzbName,
        cat: category ?? settings.category,
        priority: (addPaused ?? settings.addPaused) ? -2 : -100,
        pp: 3,
      },
      { file: buildNzbUpload(nzbName, content) },
    );
    if (!result?.nzo_ids || result.nzo_ids.length === 0) {
      throw new Error(`${this.name} rejected the NZB${result?.error ? `: ${result.error}` : ""}`);
    }
    return {
      nzbId: String(result.nzo_ids[0]),
      nzbName,
    };
  }

  async getQueueItem(nzoId: NzbId) {
    const id = String(nzoId || "").trim();
    if (!id) return null;
    const result = await this.api("queue", { nzo_ids: id });
    const slots = result?.queue?.slots || [];
    return slots.find((s: SabnzbdSlot) => String(s.nzo_id) === id) || null;
  }

  async getHistoryItem(nzoId: NzbId) {
    const id = String(nzoId || "").trim();
    if (!id) return null;
    const result = await this.api("history", { nzo_ids: id });
    const slots = result?.history?.slots || [];
    return slots.find((s: SabnzbdSlot) => String(s.nzo_id) === id) || null;
  }

  async deleteHistoryItem(
    nzoId: NzbId,
    {
      deleteFiles = false,
      historyItem = null,
    }: { deleteFiles?: boolean; historyItem?: Partial<SabnzbdSlot> | null } = {},
  ) {
    const id = String(nzoId || "").trim();
    if (!id) return false;
    const removeHistory = async () => {
      const result = await this.api("history", { name: "delete", value: id, del_files: 1 });
      return result?.status === true;
    };
    const settings = this._getSettings();
    if (!deleteFiles || !settings.deleteLeftovers) return removeHistory();
    const cleanup = folderCleanup.then(async () => {
      const item = historyItem || (await this.getHistoryItem(id));
      if (item && !(await this.sharesDownloadFolder(item))) {
        await removeSabnzbdDownloadFolder(
          item,
          await this.getDownloadDirectories(),
          settings.category,
          this,
        );
      }
      return removeHistory();
    });
    folderCleanup = cleanup.catch(() => {});
    return cleanup;
  }

  async deleteQueueItem(nzoId: NzbId) {
    const id = String(nzoId || "").trim();
    if (!id) return false;
    const result = await this.api("queue", { name: "delete", value: id, del_files: 1 });
    return result?.status === true;
  }

  async sharesDownloadFolder(item: Partial<SabnzbdSlot>) {
    const id = String(item?.nzo_id || "").trim();
    const storage = normalizeStoragePath(item?.storage);
    if (!storage) return false;
    const [queueResult, historyResult] = await Promise.all([
      this.api("queue"),
      this.api("history"),
    ]);
    return [...(queueResult?.queue?.slots || []), ...(historyResult?.history?.slots || [])].some(
      (entry) =>
        String(entry?.nzo_id || "").trim() !== id &&
        normalizeStoragePath(entry?.storage) === storage,
    );
  }

  async getDownloadDirectories() {
    const settings = this._getSettings();
    const [miscResult, categoryResult] = await Promise.all([
      this.api("get_config", { section: "misc" }).catch(() => null),
      this.api("get_config", { section: "categories" }).catch(() => null),
    ]);
    const entries = miscResult?.config?.misc || [];
    return {
      completedPath: "",
      categoryDestDir: readCategoryDirectory(categoryResult?.config?.categories, settings.category),
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
        message: `${this.name} is disabled`,
      };
    }
    if (!settings.url || !settings.apiKey) {
      return {
        ok: false,
        configured: false,
        connected: false,
        message: `${this.name} URL and API key are required`,
      };
    }
    const settingsKey = getSettingsKey(settings);
    const cached = connectionCache.get(this.key);
    if (!force && cached?.settingsKey === settingsKey && Date.now() - cached.checkedAt < 30000) {
      return cached.result;
    }
    let result: SabnzbdConnection;
    try {
      const [versionRes, directories] = await Promise.all([
        axios.get(`${this._apiUrl()}&mode=version`, { timeout: 15000 }),
        this.getDownloadDirectories(),
      ]);
      const version = versionRes.data?.version || null;
      result = {
        ok: true,
        configured: true,
        connected: true,
        version,
        downloadPath: directories.destDir || null,
        directories,
        message: `${this.name} is connected${version ? ` (v${version})` : ""}`,
      };
    } catch (error) {
      result = {
        ok: false,
        configured: true,
        connected: false,
        message: asAppError(error)?.message || `Failed to reach ${this.name}`,
      };
    }
    connectionCache.set(this.key, { checkedAt: Date.now(), result, settingsKey });
    return result;
  }
}

export const sabnzbdClient = new SabnzbdClient();
export const tidarrClient = new SabnzbdClient(null, "tidarr");
