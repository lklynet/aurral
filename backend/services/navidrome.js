import axios from "axios";
import crypto from "crypto";

const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PLAYLIST_LIBRARY_NAME = "Aurral Playlists";
const LEGACY_LIBRARY_NAMES = new Set(["Aurral Weekly Flow"]);

function normalizeLibraryPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isLegacyPlaylistLibraryPath(value) {
  const libraryPath = normalizeLibraryPath(value);
  return (
    libraryPath.endsWith(`/${LEGACY_LIBRARY_DIR}`) ||
    libraryPath === LEGACY_LIBRARY_DIR
  );
}

export class NavidromeClient {
  constructor(url, user, password) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.user = user;
    this.password = password;
  }

  isConfigured() {
    return !!(this.url && this.user && this.password);
  }

  getAuthParams() {
    const salt = crypto.randomBytes(6).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(this.password + salt)
      .digest("hex");
    return {
      u: this.user,
      t: token,
      s: salt,
      v: "1.16.1",
      c: "aurral",
      f: "json",
    };
  }

  async request(endpoint, params = {}) {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");

    try {
      const response = await axios.get(`${this.url}/rest/${endpoint}`, {
        params: {
          ...this.getAuthParams(),
          ...params,
        },
      });

      if (response.data["subsonic-response"]?.status === "failed") {
        throw new Error(
          response.data["subsonic-response"].error?.message ||
            "Navidrome request failed",
        );
      }

      return response.data["subsonic-response"];
    } catch (error) {
      console.error(`Navidrome Error [${endpoint}]:`, error.message);
      throw error;
    }
  }

  async ping() {
    return this.request("ping");
  }

  async findSong(title, artist) {
    const data = await this.request("search3", {
      query: `${artist} ${title}`,
      songCount: 5,
      artistCount: 0,
      albumCount: 0,
    });

    const songs = data.searchResult3?.song || [];
    const match = songs.find(
      (s) =>
        s.title.toLowerCase() === title.toLowerCase() &&
        s.artist.toLowerCase() === artist.toLowerCase(),
    );

    return match || null;
  }

  async searchSongsByArtist(artistName, limit = 5) {
    const data = await this.request("search3", {
      query: artistName,
      songCount: limit,
      artistCount: 0,
      albumCount: 0,
    });
    const songs = data.searchResult3?.song || [];
    const list = Array.isArray(songs) ? songs : [songs];
    return list
      .filter(
        (s) => s.artist && s.artist.toLowerCase() === artistName.toLowerCase(),
      )
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        title: s.title,
        album: s.album,
        duration: s.duration ?? 0,
      }));
  }

  getStreamUrl(songId) {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");
    const params = new URLSearchParams(this.getAuthParams());
    params.delete("f");
    return `${this.url}/rest/stream?id=${encodeURIComponent(songId)}&${params.toString()}`;
  }

  async getPlaylists() {
    const data = await this.request("getPlaylists");
    return data.playlists?.playlist || [];
  }

  async createPlaylist(name, songIds, replace = false) {
    if (!songIds || songIds.length === 0) {
      if (replace) {
        const playlists = await this.getPlaylists();
        const existing = playlists.find((p) => p.name === name);
        if (existing) {
          await this.deletePlaylist(existing.id);
        }
      }
      return null;
    }

    const playlists = await this.getPlaylists();
    const existing = playlists.find((p) => p.name === name);

    if (existing) {
      if (replace) {
        await this.deletePlaylist(existing.id);
      } else {
        const data = await this.request("updatePlaylist", {
          playlistId: existing.id,
          songIdToAdd: songIds,
        });
        return data.playlist || existing;
      }
    }

    const data = await this.request("createPlaylist", {
      name,
      songId: songIds,
    });

    return data.playlist;
  }

  async deletePlaylist(id) {
    return this.request("deletePlaylist", { id });
  }

  async addToPlaylist(playlistId, songId) {
    return this.request("updatePlaylist", {
      playlistId,
      songIdToAdd: songId,
    });
  }

  async removeFromPlaylist(playlistId, songId) {
    try {
      const playlistData = await this.request("getPlaylist", {
        id: playlistId,
      });
      const playlist = playlistData.playlist;

      if (!playlist || !playlist.entry) {
        throw new Error("Playlist not found or empty");
      }

      const entries = Array.isArray(playlist.entry)
        ? playlist.entry
        : [playlist.entry];
      const songIndex = entries.findIndex((entry) => entry.id === songId);

      if (songIndex === -1) {
        throw new Error("Song not found in playlist");
      }

      await this.request("updatePlaylist", {
        playlistId,
        songIndexToRemove: songIndex,
      });

      return { success: true };
    } catch (error) {
      throw new Error(`Failed to remove song from playlist: ${error.message}`);
    }
  }

  async _nativeLogin() {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");
    const { data } = await axios.post(
      `${this.url}/auth/login`,
      { username: this.user, password: this.password },
      { headers: { "Content-Type": "application/json" } },
    );
    const token = data.token || data.Token;
    if (!token) throw new Error("No token in login response");
    return token;
  }

  async _nativeRequest(method, path, body = null) {
    let token = await this._nativeLogin();
    const base = this.url;
    const url = path.startsWith("/") ? `${base}${path}` : `${base}/api/${path}`;
    const headers = {
      "Content-Type": "application/json",
      "X-ND-Authorization": `Bearer ${token}`,
    };
    let response;
    if (method === "GET") {
      response = await axios.get(url, { headers });
    } else if (method === "POST") {
      response = await axios.post(url, body, { headers });
    } else if (method === "PUT") {
      response = await axios.put(url, body, { headers });
    } else {
      throw new Error(`Unsupported method: ${method}`);
    }
    const newToken = response.headers["x-nd-authorization"];
    if (newToken) token = newToken;
    return response.data;
  }

  async getLibraries() {
    return this._nativeRequest("GET", "/api/library");
  }

  async createLibrary(name, path) {
    return this._nativeRequest("POST", "/api/library", { name, path });
  }

  async updateLibrary(id, payload) {
    return this._nativeRequest("PUT", `/api/library/${id}`, payload);
  }

  async scanLibrary() {
    if (!this.isConfigured()) return null;
    try {
      return await this.request("startScan");
    } catch (err) {
      console.warn("[Navidrome] scanLibrary failed:", err?.message);
      return null;
    }
  }

  async ensureWeeklyFlowLibrary(libraryPath) {
    if (!this.isConfigured()) return null;
    const name = PLAYLIST_LIBRARY_NAME;
    const normalizedPath = normalizeLibraryPath(libraryPath);
    try {
      const libs = await this.getLibraries();
      const list = Array.isArray(libs) ? libs : [];
      const byPath = list.find(
        (lib) => normalizeLibraryPath(lib.path) === normalizedPath,
      );
      if (byPath) {
        if (byPath.name !== name) {
          return this.updateLibrary(byPath.id, {
            ...byPath,
            name,
            path: normalizedPath,
          });
        }
        return byPath;
      }

      const byName = list.find(
        (lib) => lib.name === name || LEGACY_LIBRARY_NAMES.has(lib.name),
      );
      if (byName) {
        if (normalizeLibraryPath(byName.path) !== normalizedPath) {
          return this.updateLibrary(byName.id, {
            ...byName,
            name,
            path: normalizedPath,
          });
        }
        return byName;
      }

      const legacy = list.find((lib) => isLegacyPlaylistLibraryPath(lib.path));
      if (legacy) {
        return this.updateLibrary(legacy.id, {
          ...legacy,
          name,
          path: normalizedPath,
        });
      }

      return this.createLibrary(name, normalizedPath);
    } catch (err) {
      console.warn(
        "[Navidrome] ensureWeeklyFlowLibrary failed:",
        err?.response?.data?.error || err.message,
      );
      return null;
    }
  }
}
