import axios from "axios";
import crypto from "crypto";

const PLEX_TV = "https://plex.tv";
const PLEX_AUTH_APP = "https://app.plex.tv";
const PLEX_PRODUCT = "Aurral";
// Plex music libraries use the "artist" section type with these defaults.
const MUSIC_SECTION_TYPE = "artist";
const MUSIC_AGENT = "tv.plex.agents.music";
const MUSIC_SCANNER = "Plex Music";
const TRACK_TYPE = 10; // Plex metadata type for audio tracks

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
    };
    if (token) headers["X-Plex-Token"] = token;
    return headers;
  }

  static generateClientId() {
    return crypto.randomUUID();
  }

  static async generatePin(clientId) {
    const { data } = await axios.post(
      `${PLEX_TV}/api/v2/pins`,
      null,
      {
        params: { strong: true },
        headers: PlexClient.plexHeaders(clientId),
      },
    );
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
    else if (Array.isArray(data?.MediaContainer?.Device))
      list = data.MediaContainer.Device;
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
        typeof detail === "string" ? detail : error.message,
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
    const name = "Aurral Flow";
    const findExisting = (libs) =>
      libs.find(
        (lib) =>
          lib.title === name ||
          (lib.Location || []).some((loc) => loc.path === libraryPath),
      );

    const existing = findExisting(await this.getLibraries());
    if (existing) {
      // The library already exists. Reconcile its folder(s) to the desired
      // path so changing the downloads-path setting actually takes effect
      // (Plex keeps the original location otherwise).
      const currentLocations = (existing.Location || [])
        .map((loc) => loc.path)
        .filter(Boolean);
      const alreadyCorrect =
        currentLocations.length === 1 && currentLocations[0] === libraryPath;
      if (!alreadyCorrect) {
        try {
          await this.setLibraryLocations(existing.key, [libraryPath]);
          return findExisting(await this.getLibraries()) || existing;
        } catch (err) {
          console.warn(
            "[Plex] Could not update Aurral library location:",
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
      await this.request("/library/sections", {
        method: "POST",
        params: {
          name,
          type: MUSIC_SECTION_TYPE,
          agent: MUSIC_AGENT,
          scanner: MUSIC_SCANNER,
          language: "en-US",
          location: libraryPath,
        },
      });
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
        `Plex accepted the request but no "Aurral Flow" library appeared. Verify the Plex server can access the path "${libraryPath}".`,
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
   * Replace a library section's folder locations. Plex expects repeated
   * `location=` query params (no array brackets), so the query is built by
   * hand. The Plex server must be able to browse each path.
   */
  async setLibraryLocations(sectionId, locations) {
    const qs = new URLSearchParams();
    qs.set("agent", MUSIC_AGENT);
    for (const loc of locations) qs.append("location", loc);
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

  async getPlaylists() {
    const data = await this.request("/playlists", {
      params: { playlistType: "audio" },
    });
    return data?.MediaContainer?.Metadata || [];
  }

  async getPlaylistItems(playlistRatingKey) {
    const data = await this.request(`/playlists/${playlistRatingKey}/items`);
    const items = data?.MediaContainer?.Metadata || [];
    return items.map((i) => i.ratingKey).filter(Boolean);
  }

  _metadataUri(machineId, ratingKeys) {
    const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).join(
      ",",
    );
    return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${keys}`;
  }

  async createPlaylist(title, ratingKeys, replace = false) {
    const machineId = await this.getMachineIdentifier();
    if (!machineId) throw new Error("Could not resolve Plex machineIdentifier");

    const existing = (await this.getPlaylists()).find(
      (p) => p.title === title,
    );

    if (existing && replace) {
      // Skip delete+recreate when the track set already matches (order-insensitive).
      const current = await this.getPlaylistItems(existing.ratingKey);
      const desiredSet = new Set((ratingKeys || []).map(String));
      const currentSet = new Set(current.map(String));
      const unchanged =
        desiredSet.size === currentSet.size &&
        [...desiredSet].every((k) => currentSet.has(k));
      if (unchanged) return existing;
      await this.deletePlaylist(existing.ratingKey);
    } else if (existing && !replace) {
      if (ratingKeys?.length) {
        await this.addToPlaylist(existing.ratingKey, ratingKeys);
      }
      return existing;
    }

    if (!ratingKeys?.length) return null;

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

  async deletePlaylist(playlistRatingKey) {
    return this.request(`/playlists/${playlistRatingKey}`, {
      method: "DELETE",
    });
  }
}
