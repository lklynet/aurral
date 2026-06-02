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

/**
 * Client for the Plex Media Server + plex.tv APIs.
 *
 * Authentication uses the PIN-based OAuth flow (see the static auth helpers).
 * Once a token is obtained it is used as `X-Plex-Token` against the user's
 * local Plex Media Server for library and playlist management.
 */
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

  // --- plex.tv OAuth (PIN) flow -------------------------------------------

  static plexHeaders(clientId, { token } = {}) {
    const headers = {
      Accept: "application/json",
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Client-Identifier": clientId,
    };
    if (token) headers["X-Plex-Token"] = token;
    return headers;
  }

  /** Generate a fresh, stable client identifier for this Aurral install. */
  static generateClientId() {
    return crypto.randomUUID();
  }

  /**
   * Request a strong PIN from plex.tv. Returns { id, code }.
   * The user authorizes the PIN at the URL from `buildAuthUrl`.
   */
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

  /** Build the app.plex.tv URL the user visits to authorize the PIN. */
  static buildAuthUrl(clientId, code, forwardUrl) {
    const params = new URLSearchParams({
      clientID: clientId,
      code,
      "context[device][product]": PLEX_PRODUCT,
    });
    if (forwardUrl) params.set("forwardUrl", forwardUrl);
    return `${PLEX_AUTH_APP}/auth#?${params.toString()}`;
  }

  /**
   * Poll a PIN. Returns the authToken once the user authorizes, else null.
   */
  static async checkPin(pinId, code, clientId) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/pins/${pinId}`, {
      params: { code },
      headers: PlexClient.plexHeaders(clientId),
    });
    return data.authToken || null;
  }

  /** Validate a token against plex.tv. Returns the account object or null. */
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

  /**
   * Discover Plex servers owned by / shared with the account.
   * Returns [{ name, clientIdentifier, owned, connections: [{ uri, local }] }].
   */
  static async getResources(token, clientId) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/resources`, {
      params: { includeHttps: 1, includeRelay: 1 },
      headers: PlexClient.plexHeaders(clientId, { token }),
    });
    const list = Array.isArray(data) ? data : [];
    return list
      .filter((r) => r.provides && r.provides.includes("server"))
      .map((r) => ({
        name: r.name,
        clientIdentifier: r.clientIdentifier,
        owned: !!r.owned,
        connections: (r.connections || []).map((c) => ({
          uri: c.uri,
          local: !!c.local,
          address: c.address,
          port: c.port,
        })),
      }));
  }

  // --- Plex Media Server requests -----------------------------------------

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

  /** Test connectivity + capture the server's machineIdentifier. */
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

  /**
   * Find (or create) the Aurral music library pointed at `libraryPath`.
   * Mirrors NavidromeClient.ensureWeeklyFlowLibrary.
   */
  async ensureWeeklyFlowLibrary(libraryPath) {
    if (!this.isConfigured()) return null;
    const name = "Aurral Flow";
    try {
      const libs = await this.getLibraries();
      const existing = libs.find(
        (lib) =>
          lib.title === name ||
          (lib.Location || []).some((loc) => loc.path === libraryPath),
      );
      if (existing) return existing;

      // POST /library/sections creates the library; returns the new section.
      const data = await this.request("/library/sections", {
        method: "POST",
        params: {
          name,
          type: MUSIC_SECTION_TYPE,
          agent: MUSIC_AGENT,
          scanner: MUSIC_SCANNER,
          language: "en",
          location: libraryPath,
        },
      });
      return data?.MediaContainer?.Directory?.[0] || null;
    } catch (err) {
      console.warn(
        "[Plex] ensureWeeklyFlowLibrary failed:",
        err?.response?.data || err.message,
      );
      return null;
    }
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
   * Fetch all tracks in a library section with their on-disk file paths.
   * Returns [{ ratingKey, title, artist, file }].
   */
  async getTracks(sectionId) {
    const data = await this.request(`/library/sections/${sectionId}/all`, {
      params: { type: TRACK_TYPE },
    });
    const items = data?.MediaContainer?.Metadata || [];
    return items.map((t) => ({
      ratingKey: t.ratingKey,
      title: t.title,
      artist: t.grandparentTitle || t.originalTitle,
      file: t.Media?.[0]?.Part?.[0]?.file || null,
    }));
  }

  async getPlaylists() {
    const data = await this.request("/playlists", {
      params: { playlistType: "audio" },
    });
    return data?.MediaContainer?.Metadata || [];
  }

  _metadataUri(machineId, ratingKeys) {
    const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).join(
      ",",
    );
    return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${keys}`;
  }

  /**
   * Create (or replace) an audio playlist from a list of track ratingKeys.
   * Mirrors NavidromeClient.createPlaylist.
   */
  async createPlaylist(title, ratingKeys, replace = false) {
    const machineId = await this.getMachineIdentifier();
    if (!machineId) throw new Error("Could not resolve Plex machineIdentifier");

    const existing = (await this.getPlaylists()).find(
      (p) => p.title === title,
    );

    if (existing && replace) {
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
