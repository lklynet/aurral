import axios from "../../lib/axiosFetch.js";
import crypto from "crypto";
import { AURRAL_FLOWS_DIR } from "./playlistPaths.js";

const PLEX_TV = "https://plex.tv";
const PLEX_AUTH_APP = "https://app.plex.tv";
const PLEX_PRODUCT = "Aurral";
// Plex music libraries use the "artist" section type with these defaults.
export const MUSIC_SECTION_TYPE = "artist";
const MUSIC_AGENT = "tv.plex.agents.music";
const MUSIC_SCANNER = "Plex Music";
const TRACK_TYPE = 10; // Plex metadata type for audio tracks

function parsePlexXmlTags(xml, tagName) {
  const tagRe = new RegExp(`<${tagName}\\b([^>]*)/?\\s*>`, "gi");
  const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  const out = [];
  let match;
  while ((match = tagRe.exec(xml))) {
    const attrs = {};
    let attrMatch;
    attrRe.lastIndex = 0;
    while ((attrMatch = attrRe.exec(match[1]))) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    out.push(attrs);
  }
  return out;
}

function toBool(value) {
  return value === true || value === "1" || value === 1;
}

export class PlexClient {
  constructor(url, token, clientId) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.token = token || null;
    this.clientId = clientId || null;
    this._machineIdentifier = null;
  }

  isConfigured() {
    return !!(this.url && this.token);
  }

  static plexHeaders(clientId, { token } = {}) {
    const headers = {
      Accept: "application/json",
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Version": "1.0",
      "X-Plex-Platform": "Node.js",
      "X-Plex-Platform-Version": process.version,
      "X-Plex-Device": "Server",
      "X-Plex-Device-Name": PLEX_PRODUCT,
    };
    if (token) headers["X-Plex-Token"] = token;
    return headers;
  }

  static generateClientId() {
    return crypto.randomUUID();
  }

  static async generatePin(clientId) {
    const { data } = await axios.post(`${PLEX_TV}/api/v2/pins`, null, {
      params: { strong: true },
      headers: PlexClient.plexHeaders(clientId),
    });
    return { id: data.id, code: data.code };
  }

  static buildAuthUrl(clientId, code, forwardUrl) {
    const params = new URLSearchParams({
      clientID: clientId,
      code,
      "context[device][product]": PLEX_PRODUCT,
    });
    if (forwardUrl) params.set("forwardUrl", forwardUrl);
    return `${PLEX_AUTH_APP}/auth#?${params.toString()}`;
  }

  static async checkPin(pinId, code, clientId) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/pins/${pinId}`, {
      params: { code },
      headers: PlexClient.plexHeaders(clientId),
    });
    return data.authToken || null;
  }

  static async validateToken(token, clientId) {
    try {
      const { data } = await axios.get(`${PLEX_TV}/api/v2/user`, {
        headers: PlexClient.plexHeaders(clientId, { token }),
      });
      return data || null;
    } catch {
      return null;
    }
  }

  static async getResources(token, clientId) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/resources`, {
      params: { includeHttps: 1, includeRelay: 1 },
      headers: PlexClient.plexHeaders(clientId, { token }),
    });
    // v2 returns a JSON array; tolerate XML-shaped responses too.
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data?.MediaContainer?.Device)) list = data.MediaContainer.Device;
    else if (data?.MediaContainer?.Device) list = [data.MediaContainer.Device];

    const servers = list
      .filter((r) => String(r.provides || "").includes("server"))
      .map((r) => {
        const rawConns = r.connections || r.Connection || [];
        const conns = Array.isArray(rawConns) ? rawConns : [rawConns];
        return {
          name: r.name,
          clientIdentifier: r.clientIdentifier,
          owned: r.owned === true || r.owned === "1" || r.owned === 1,
          accessToken: r.accessToken || null,
          connections: conns.map((c) => ({
            uri: c.uri,
            local: c.local === true || c.local === "1" || c.local === 1,
            address: c.address,
            port: c.port,
          })),
        };
      });
    console.log(
      `[Plex] getResources: ${list.length} device(s) returned, ${servers.length} provide "server"`,
    );
    return { servers, total: list.length };
  }

  static async getHomeUsers(adminToken, adminClientId) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/home/users`, {
      headers: PlexClient.plexHeaders(adminClientId, { token: adminToken }),
    });

    let rawUsers = [];
    if (typeof data === "string") {
      rawUsers = parsePlexXmlTags(data, "[Uu]ser");
    } else if (Array.isArray(data?.users)) {
      rawUsers = data.users;
    } else if (Array.isArray(data?.MediaContainer?.User)) {
      rawUsers = data.MediaContainer.User;
    } else if (data?.MediaContainer?.User) {
      rawUsers = [data.MediaContainer.User];
    } else if (Array.isArray(data)) {
      rawUsers = data;
    }

    return rawUsers.map((u) => ({
      id: u.id,
      uuid: u.uuid,
      title: u.title || u.username || u.friendlyName,
      username: u.username || null,
      email: u.email || null,
      restricted: toBool(u.restricted),
      admin: toBool(u.admin),
      guest: toBool(u.guest),
    }));
  }

  static async switchHomeUser(homeUserId, adminToken, adminClientId, targetClientId, pin = null) {
    const headers = PlexClient.plexHeaders(targetClientId, { token: adminToken });
    const params = pin ? { pin } : {};
    const paths = [
      `${PLEX_TV}/api/v2/home/users/${homeUserId}/switch`,
      `${PLEX_TV}/api/home/users/${homeUserId}/switch`,
    ];

    let lastError = null;
    for (const path of paths) {
      try {
        const { data } = await axios.post(path, null, { params, headers });
        if (typeof data === "string") {
          const [tag] = parsePlexXmlTags(data, "user");
          const token = tag?.authenticationToken || tag?.authToken;
          if (token) return token;
        } else {
          const token =
            data?.authToken || data?.authenticationToken || data?.user?.authToken || null;
          if (token) return token;
        }
        return null;
      } catch (error) {
        lastError = error;
        if (error.response?.status !== 404) throw error;
      }
    }
    throw lastError || new Error("Plex switch-user request failed");
  }

  async request(path, { params = {}, method = "GET", data = null } = {}) {
    if (!this.isConfigured()) throw new Error("Plex not configured");
    try {
      const response = await axios({
        method,
        url: `${this.url}${path}`,
        params,
        data,
        headers: PlexClient.plexHeaders(this.clientId, { token: this.token }),
      });
      return response.data;
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error(
        `Plex Error [${method} ${path}]:`,
        typeof detail === "string" ? detail.slice(0, 200) : error.message,
        "| status:",
        error.response?.status,
        "| clientId:",
        this.clientId,
        "| headers:",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(error.response?.headers || {}).filter(
              ([key]) => !/^(set-cookie|authorization|x-plex-token)$/i.test(key),
            ),
          ),
        ),
      );
      throw error;
    }
  }

  async ping() {
    const data = await this.request("/identity");
    const mc = data?.MediaContainer || {};
    if (mc.machineIdentifier) this._machineIdentifier = mc.machineIdentifier;
    return mc;
  }

  async getMachineIdentifier() {
    if (this._machineIdentifier) return this._machineIdentifier;
    await this.ping();
    return this._machineIdentifier;
  }

  async getLibraries() {
    const data = await this.request("/library/sections");
    return data?.MediaContainer?.Directory || [];
  }

  async ensureWeeklyFlowLibrary(libraryPath) {
    if (!this.isConfigured()) return null;
    const name = "Aurral";
    const flowRoot = libraryPath.replace(/\/+$/, "");
    const locations = [
      libraryPath,
      `${flowRoot}/${AURRAL_FLOWS_DIR}`,
    ];
    // Also match the legacy "Aurral Flow" name so existing libraries are reused
    // and renamed rather than duplicated.
    const findExisting = (libs) =>
      libs.find(
        (lib) =>
          lib.title === name ||
          lib.title === "Aurral Flow" ||
          (lib.Location || []).some((loc) => locations.includes(loc.path)),
      );

    const existing = findExisting(await this.getLibraries());
    if (existing) {
      // Reconcile name + folder so a rename or a changed downloads-path setting
      // actually takes effect (Plex keeps the originals otherwise).
      const currentLocations = (existing.Location || []).map((loc) => loc.path).filter(Boolean);
      const locationOk =
        currentLocations.length === locations.length &&
        locations.every((location) => currentLocations.includes(location));
      const nameOk = existing.title === name;
      if (!locationOk || !nameOk) {
        try {
          await this.editLibrary(existing.key, { name, locations });
          return findExisting(await this.getLibraries()) || existing;
        } catch (err) {
          console.warn(
            "[Plex] Could not update Aurral library:",
            err?.response?.data || err.message,
          );
        }
      }
      return existing;
    }

    // POST /library/sections creates the library. Plex's response shape here
    // is inconsistent across versions, so we create then re-read the section
    // list to resolve the new library (and its `key`) reliably.
    try {
      const params = new URLSearchParams({
        name,
        type: MUSIC_SECTION_TYPE,
        agent: MUSIC_AGENT,
        scanner: MUSIC_SCANNER,
        language: "en-US",
      });
      for (const location of locations) params.append("location", location);
      await this.request(`/library/sections?${params.toString()}`, { method: "POST" });
    } catch (err) {
      const detail = err?.response?.data || err.message;
      const status = err?.response?.status;
      throw new Error(
        `Plex rejected library creation (${status || "no status"}) for path "${libraryPath}": ${
          typeof detail === "string" ? detail : JSON.stringify(detail)
        }`,
      );
    }

    const created = findExisting(await this.getLibraries());
    if (!created) {
      throw new Error(
        `Plex accepted the request but no "Aurral" library appeared. Verify the Plex server can access the path "${libraryPath}".`,
      );
    }
    return created;
  }

  async scanLibrary(sectionId) {
    if (!this.isConfigured() || sectionId == null) return null;
    try {
      return await this.request(`/library/sections/${sectionId}/refresh`);
    } catch (err) {
      console.warn("[Plex] scanLibrary failed:", err?.message);
      return null;
    }
  }

  /**
   * Rename a library section and/or replace its folder locations. Plex expects
   * repeated `location=` query params (no array brackets), so the query is
   * built by hand. The Plex server must be able to browse each path.
   */
  async editLibrary(sectionId, { name, locations } = {}) {
    const qs = new URLSearchParams();
    qs.set("agent", MUSIC_AGENT);
    if (name) qs.set("name", name);
    for (const loc of locations || []) qs.append("location", loc);
    return this.request(`/library/sections/${sectionId}?${qs.toString()}`, {
      method: "PUT",
    });
  }

  async getTracks(sectionId) {
    const pageSize = 200;
    const out = [];
    let start = 0;
    for (;;) {
      const data = await this.request(`/library/sections/${sectionId}/all`, {
        params: {
          type: TRACK_TYPE,
          "X-Plex-Container-Start": start,
          "X-Plex-Container-Size": pageSize,
        },
      });
      const mc = data?.MediaContainer || {};
      const items = mc.Metadata || [];
      for (const t of items) {
        const files = (t.Media || [])
          .flatMap((m) => (m.Part || []).map((p) => p.file))
          .filter(Boolean);
        out.push({
          ratingKey: t.ratingKey,
          title: t.title,
          artist: t.grandparentTitle || t.originalTitle,
          files,
        });
      }
      const total = Number(mc.totalSize ?? mc.size ?? items.length);
      start += items.length;
      if (items.length === 0 || start >= total) break;
    }
    return out;
  }

  async getSampleTrack(sectionId) {
    const data = await this.request(`/library/sections/${sectionId}/all`, {
      params: {
        type: TRACK_TYPE,
        "X-Plex-Container-Start": 0,
        "X-Plex-Container-Size": 1,
      },
    });
    const item = data?.MediaContainer?.Metadata?.[0];
    if (!item) return null;
    const files = (item.Media || [])
      .flatMap((m) => (m.Part || []).map((p) => p.file))
      .filter(Boolean);
    return { ratingKey: item.ratingKey, title: item.title, files };
  }

  async getPlaylists() {
    const data = await this.request("/playlists", {
      params: { playlistType: "audio" },
    });
    return data?.MediaContainer?.Metadata || [];
  }

  async getPlaylistItems(playlistRatingKey) {
    const data = await this.request(`/playlists/${playlistRatingKey}/items`);
    const items = data?.MediaContainer?.Metadata || [];
    return items
      .map((i) => ({ ratingKey: i.ratingKey, playlistItemID: i.playlistItemID }))
      .filter((i) => i.ratingKey && i.playlistItemID != null);
  }

  _metadataUri(machineId, ratingKeys) {
    const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).join(",");
    return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${keys}`;
  }

  async _createPlaylist(title, ratingKeys) {
    const machineId = await this.getMachineIdentifier();
    if (!machineId) throw new Error("Could not resolve Plex machineIdentifier");
    const data = await this.request("/playlists", {
      method: "POST",
      params: {
        type: "audio",
        title,
        smart: 0,
        uri: this._metadataUri(machineId, ratingKeys),
      },
    });
    return data?.MediaContainer?.Metadata?.[0] || null;
  }

  async addToPlaylist(playlistRatingKey, ratingKeys) {
    const machineId = await this.getMachineIdentifier();
    return this.request(`/playlists/${playlistRatingKey}/items`, {
      method: "PUT",
      params: { uri: this._metadataUri(machineId, ratingKeys) },
    });
  }

  async removePlaylistItem(playlistRatingKey, playlistItemID) {
    return this.request(`/playlists/${playlistRatingKey}/items/${playlistItemID}`, {
      method: "DELETE",
    });
  }

  async updatePlaylistDetails(playlistRatingKey, { title, summary } = {}) {
    const params = {};
    if (title != null) params.title = title;
    if (summary != null) params.summary = summary;
    if (!Object.keys(params).length) return null;
    return this.request(`/playlists/${playlistRatingKey}`, {
      method: "PUT",
      params,
    });
  }

  async deletePlaylist(playlistRatingKey) {
    return this.request(`/playlists/${playlistRatingKey}`, {
      method: "DELETE",
    });
  }

  async syncPlaylist({
    ratingKey = null,
    previousTitle = null,
    previousDescription = null,
    title,
    description = null,
    ratingKeys,
  }) {
    let targetRatingKey = ratingKey;
    let items = null;
    let needsDetailsUpdate = false;

    if (targetRatingKey) {
      try {
        items = await this.getPlaylistItems(targetRatingKey);
        needsDetailsUpdate = previousTitle !== title || previousDescription !== description;
      } catch (error) {
        if (error?.response?.status !== 404) throw error;
        targetRatingKey = null;
      }
    }

    if (!targetRatingKey) {
      if (!ratingKeys?.length) return null;
      const created = await this._createPlaylist(title, ratingKeys);
      if (!created?.ratingKey) return null;
      if (description) {
        await this.updatePlaylistDetails(created.ratingKey, { summary: description });
      }
      return { ratingKey: created.ratingKey };
    }

    if (!ratingKeys?.length) {
      await this.deletePlaylist(targetRatingKey);
      return null;
    }

    const desiredSet = new Set(ratingKeys.map(String));
    const currentSet = new Set((items || []).map((i) => String(i.ratingKey)));
    const toRemove = (items || []).filter((i) => !desiredSet.has(String(i.ratingKey)));
    const toAdd = ratingKeys.filter((k) => !currentSet.has(String(k)));

    for (const item of toRemove) {
      try {
        await this.removePlaylistItem(targetRatingKey, item.playlistItemID);
      } catch (err) {
        console.warn(
          `[Plex] Failed to remove item ${item.playlistItemID} from playlist ${targetRatingKey}:`,
          err?.message,
        );
      }
    }
    if (toAdd.length) await this.addToPlaylist(targetRatingKey, toAdd);
    if (needsDetailsUpdate) {
      await this.updatePlaylistDetails(targetRatingKey, { title, summary: description || "" });
    }

    return { ratingKey: targetRatingKey };
  }
}
