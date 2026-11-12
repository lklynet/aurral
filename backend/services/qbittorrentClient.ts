import * as v from "valibot";
import { http, type HttpOptions, type HttpResponse } from "../../lib/http.ts";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import type { SettingsRow } from "../db/rows.ts";
import { asAppError } from "../../lib/errors.ts";
import { dbOps } from "../db/helpers/index.ts";
import { readMany } from "./integrationData.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { normalizeBaseUrl } from "./usenetClientCommon.ts";

export const qbittorrentSettings = Object.freeze({
  key: "qbittorrent",
  label: "qBittorrent",
  subtitle: "Torrents",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable qBittorrent", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:8080",
    }),
    Object.freeze({ key: "username", label: "Username", type: "text", section: "Connection" }),
    Object.freeze({
      key: "password",
      label: "Password",
      type: "password",
      secret: true,
      section: "Connection",
    }),
    Object.freeze({ key: "category", label: "Category", type: "text", section: "Downloads" }),
    Object.freeze({
      key: "priority",
      label: "Track priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Downloads",
    }),
    Object.freeze({
      key: "albumPriority",
      label: "Album priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Downloads",
      hint: "Empty uses track priority.",
    }),
  ]),
  defaults: Object.freeze({
    enabled: false,
    url: "",
    username: "",
    password: "",
    category: "aurral",
    priority: 30,
  }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

type QbittorrentConfig = Record<string, unknown> | null;

function getSettings(config: QbittorrentConfig) {
  const qbittorrent = config || dbOps.getSettings()?.integrations?.qbittorrent || {};
  return {
    enabled: qbittorrent.enabled === true,
    url: normalizeBaseUrl(qbittorrent.url),
    username: String(qbittorrent.username || "").trim(),
    password: String(qbittorrent.password || ""),
    category: String(qbittorrent.category ?? "aurral").trim(),
  };
}

type Settings = ReturnType<typeof getSettings>;

const torrentSchema = v.looseObject({
  hash: v.string(),
  name: v.optional(v.string(), ""),
  state: v.optional(v.string(), ""),
  progress: v.optional(v.number(), 0),
  tags: v.optional(v.string(), ""),
  save_path: v.optional(v.string(), ""),
});

const fileSchema = v.looseObject({
  index: v.optional(v.number()),
  name: v.string(),
  size: v.optional(v.number(), 0),
  priority: v.optional(v.number(), 1),
});

// Download workers start fresh for each step, so the session cookie is kept
// in the database for all of them. It belongs to one URL and login.
const SESSION_KEY = "qbittorrentSession";
const sessionSchema = v.object({ account: v.string(), cookie: v.string() });
const readSessionStmt = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const saveSessionStmt = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
);

const account = (settings: Settings) => `${settings.url}\0${settings.username}`;

function savedCookie(settings: Settings) {
  const session = dbHelpers.readJSON(
    sessionSchema,
    readSessionStmt.get(SESSION_KEY)?.value,
    SESSION_KEY,
  );
  return session?.account === account(settings) ? session.cookie : null;
}

async function login(settings: Settings) {
  const response = await http.post(
    `${settings.url}/api/v2/auth/login`,
    new URLSearchParams({ username: settings.username, password: settings.password }),
    { headers: { Referer: settings.url }, timeoutMs: 15000, okStatus: () => true },
  );
  if (response.status === 403)
    throw new Error("qBittorrent blocked Aurral after too many failed sign-ins");
  const cookie = String(response.headers["set-cookie"] || "").split(";")[0];
  if (response.status >= 300 || !cookie)
    throw new Error("qBittorrent rejected the username or password");
  saveSessionStmt.run(SESSION_KEY, JSON.stringify({ account: account(settings), cookie }));
  return cookie;
}

export class QbittorrentClient {
  key = "qbittorrent" as const;
  name = "qBittorrent" as const;
  _config: QbittorrentConfig = null;

  updateConfig(config: QbittorrentConfig = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this._config);
  }

  isConfigured() {
    const { enabled, url } = this._getSettings();
    return enabled && Boolean(url);
  }

  getStatus() {
    const { enabled } = this._getSettings();
    return { enabled, configured: this.isConfigured() };
  }

  // qBittorrent ends a session after an hour idle, so a refused request signs
  // in again once. Without a username, qBittorrent trusts Aurral's address.
  async _request(
    path: string,
    options: HttpOptions = {},
    retry = false,
    accepted: number[] = [],
  ): Promise<HttpResponse> {
    const settings = this._getSettings();
    const cookie = settings.username
      ? (!retry && savedCookie(settings)) || (await login(settings))
      : null;
    const response = await http.request(`${settings.url}${path}`, {
      timeoutMs: 30000,
      ...options,
      headers: { Referer: settings.url, ...(cookie && { Cookie: cookie }) },
      okStatus: () => true,
    });
    if (response.status === 403 && settings.username && !retry)
      return this._request(path, options, true, accepted);
    if (response.status >= 400 && !accepted.includes(response.status))
      throw new Error(`qBittorrent answered ${path} with HTTP ${response.status}`);
    return response;
  }

  async testConnection() {
    const settings = this._getSettings();
    if (!settings.enabled)
      return { ok: false, configured: false, connected: false, message: "qBittorrent is disabled" };
    if (!settings.url)
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "qBittorrent URL is required",
      };
    try {
      const response = await this._request("/api/v2/app/version", {}, true);
      const version = String(response.data || "").trim();
      const connected = `qBittorrent ${version} is connected`.replace(/\s+/gu, " ");
      if (prowlarrClient.isConfigured())
        return { ok: true, configured: true, connected: true, version, message: connected };
      return {
        ok: true,
        warning: true,
        configured: true,
        connected: true,
        version,
        message: `${connected}. Set up Prowlarr so Aurral can search for torrents.`,
      };
    } catch (error) {
      return {
        ok: false,
        configured: true,
        connected: false,
        message: asAppError(error)?.message || "Failed to reach qBittorrent",
      };
    }
  }

  async addTorrent(torrent: { magnet: string } | { file: Buffer }, tag: string) {
    const { category } = this._getSettings();
    const form = new FormData();
    if ("magnet" in torrent) form.append("urls", torrent.magnet);
    else form.append("torrents", new Blob([new Uint8Array(torrent.file)]), "release.torrent");
    if (category) form.append("category", category);
    form.append("tags", tag);
    form.append("stopCondition", "MetadataReceived");
    const response = await this._request(
      "/api/v2/torrents/add",
      { method: "POST", body: form },
      false,
      [409],
    );
    return response.status !== 409 && !/fails/iu.test(String(response.data ?? ""));
  }

  // Older qBittorrent ignores the tag filter, so the tags are checked here too.
  async torrentsTagged(tag: string) {
    const endpoint = "/api/v2/torrents/info";
    const response = await this._request(endpoint, { query: { tag } });
    return readMany(torrentSchema, response.data, { service: "qBittorrent", endpoint }).filter(
      (torrent) =>
        torrent.tags
          .split(",")
          .map((entry) => entry.trim())
          .includes(tag),
    );
  }

  // Older qBittorrent leaves out the index, which is the file's position.
  async torrentFiles(hash: string) {
    const endpoint = "/api/v2/torrents/files";
    const response = await this._request(endpoint, { query: { hash } });
    return readMany(fileSchema, response.data, { service: "qBittorrent", endpoint }).map(
      (file, position) => ({ ...file, index: file.index ?? position }),
    );
  }

  async skipFiles(hash: string, indexes: number[]) {
    if (indexes.length === 0) return;
    await this._request("/api/v2/torrents/filePrio", {
      method: "POST",
      body: new URLSearchParams({ hash, id: indexes.join("|"), priority: "0" }),
    });
  }

  // qBittorrent 5 renamed resume to start.
  async startTorrent(hash: string) {
    const body = () => new URLSearchParams({ hashes: hash });
    const response = await this._request(
      "/api/v2/torrents/start",
      { method: "POST", body: body() },
      false,
      [404],
    );
    if (response.status === 404)
      await this._request("/api/v2/torrents/resume", { method: "POST", body: body() });
  }

  async addTag(hash: string, tag: string) {
    await this._request("/api/v2/torrents/addTags", {
      method: "POST",
      body: new URLSearchParams({ hashes: hash, tags: tag }),
    });
  }

  async deleteTorrents(hashes: string[]) {
    if (hashes.length === 0) return;
    await this._request("/api/v2/torrents/delete", {
      method: "POST",
      body: new URLSearchParams({ hashes: hashes.join("|"), deleteFiles: "true" }),
    });
  }
}

export const qbittorrentClient = new QbittorrentClient();
