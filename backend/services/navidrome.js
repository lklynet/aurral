import axios from "../../lib/axiosFetch.js";
import crypto from "crypto";
import { logger } from "./logger.js";

const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PLAYLIST_LIBRARY_NAME = "Aurral Playlists";
const LEGACY_LIBRARY_NAMES = new Set(["Aurral Weekly Flow"]);
const PLAYLIST_SONG_BATCH_SIZE = 50;
const NAVIDROME_SONG_PAGE_SIZE = 1_000;
const NAVIDROME_RATE_LIMIT_RETRIES = 2;
const NAVIDROME_RATE_LIMIT_DELAY_MS = 250;
const NAVIDROME_RATE_LIMIT_MAX_DELAY_MS = 5_000;
const NAVIDROME_NETWORK_RETRIES = 2;
const NAVIDROME_RETRYABLE_READ_ENDPOINTS = new Set([
  "ping",
  "search3",
  "getPlaylists",
  "getPlaylist",
]);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeLibraryPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isLegacyPlaylistLibraryPath(value) {
  const libraryPath = normalizeLibraryPath(value);
  return libraryPath.endsWith(`/${LEGACY_LIBRARY_DIR}`) || libraryPath === LEGACY_LIBRARY_DIR;
}

export class NavidromeClient {
  constructor(url, user, password) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.user = user;
    this.password = password;
    this._libraryPaths = [];
    this._nativeTokenPromise = null;
    this._indexedSongsPromise = null;
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
      for (let attempt = 0; ; attempt += 1) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...this.getAuthParams(), ...params })) {
          if (Array.isArray(value)) {
            for (const item of value) query.append(key, item);
          } else if (value != null) {
            query.set(key, value);
          }
        }
        try {
          const endpointUrl = `${this.url}/rest/${endpoint}`;
          const response = endpoint === "updatePlaylist"
            ? await axios.post(endpointUrl, query, { preserveMethodOnRedirect: true })
            : await axios.get(`${endpointUrl}?${query}`);

          if (response.data["subsonic-response"]?.status === "failed") {
            const responseError = response.data["subsonic-response"].error || {};
            const error = new Error(responseError.message || "Navidrome request failed");
            error.code = responseError.code;
            throw error;
          }

          return response.data["subsonic-response"];
        } catch (error) {
          const isNetworkFailure = error instanceof TypeError && !error?.response;
          if (isNetworkFailure) {
            if (!NAVIDROME_RETRYABLE_READ_ENDPOINTS.has(endpoint) || attempt >= NAVIDROME_NETWORK_RETRIES) {
              throw error;
            }
            await wait(NAVIDROME_RATE_LIMIT_DELAY_MS);
            continue;
          }
          if (!error?.response) throw error;
          if (error.response.status !== 429 || attempt >= NAVIDROME_RATE_LIMIT_RETRIES) throw error;
          const retryAfterHeader = error.response.headers?.["retry-after"]?.trim();
          const retryAfter = Number(retryAfterHeader);
          const delay = retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1000, NAVIDROME_RATE_LIMIT_MAX_DELAY_MS)
            : NAVIDROME_RATE_LIMIT_DELAY_MS;
          await wait(Math.max(0, delay));
        }
      }
    } catch (error) {
      console.error(`Navidrome Error [${endpoint}]:`, error.message);
      throw error;
    }
  }

  async ping() {
    return this.request("ping");
  }

  async findSong(_title, _artist, track = {}) {
    const normalizedPath = normalizeLibraryPath(track.path).toLowerCase();
    const relativePaths = this._libraryPaths
      .map((libraryPath) => normalizeLibraryPath(libraryPath).toLowerCase())
      .filter((libraryPath) => normalizedPath.startsWith(`${libraryPath}/`))
      .map((libraryPath) => normalizedPath.slice(libraryPath.length + 1));
    const indexedSongs = await this._getIndexedSongs();
    const normalizeSongPath = (song) => normalizeLibraryPath(song.path).toLowerCase();
    const exactPathMatch = normalizedPath
      ? indexedSongs.find((song) => normalizeSongPath(song) === normalizedPath)
      : null;
    if (exactPathMatch) return exactPathMatch;

    const relativeMatches = indexedSongs.filter((song) => {
      const songPath = normalizeSongPath(song);
      return songPath && relativePaths.includes(songPath);
    });
    if (relativeMatches.length === 1) return relativeMatches[0];

    const mbid = String(track.mbid || "").trim().toLowerCase();
    if (mbid) {
      const mbidMatch = indexedSongs.find(
        (song) => String(song.musicBrainzId || "").trim().toLowerCase() === mbid,
      );
      if (mbidMatch) return mbidMatch;
    }

    const cleanTitle = String(_title || track.title || track.trackName || "").trim().toLowerCase();
    const cleanArtist = String(_artist || track.artist || track.artistName || "").trim().toLowerCase();
    if (cleanTitle && cleanArtist) {
      const candidateMatches = indexedSongs.filter(
        (song) =>
          String(song.title || "").trim().toLowerCase() === cleanTitle &&
          String(song.artist || "").trim().toLowerCase() === cleanArtist,
      );
      if (candidateMatches.length === 1) return candidateMatches[0];
      if (candidateMatches.length > 1) {
        const cleanAlbum = String(track.album || track.albumName || "").trim().toLowerCase();
        if (cleanAlbum) {
          const albumMatches = candidateMatches.filter(
            (song) => String(song.album || "").trim().toLowerCase() === cleanAlbum,
          );
          if (albumMatches.length === 1) return albumMatches[0];
        }
      }
    }

    return null;
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
      .filter((s) => s.artist && s.artist.toLowerCase() === artistName.toLowerCase())
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
    const playlists = data.playlists?.playlist || [];
    return Array.isArray(playlists) ? playlists : [playlists];
  }

  async getPlaylist(id) {
    const data = await this.request("getPlaylist", { id });
    return data.playlist || null;
  }

  async createPlaylist(name, songIds) {
    const ids = Array.isArray(songIds) ? songIds : [];
    const data = await this.request("createPlaylist", {
      name,
      songId: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    const playlist = data.playlist || null;
    if (!playlist?.id) return playlist;
    for (let index = PLAYLIST_SONG_BATCH_SIZE; index < ids.length; index += PLAYLIST_SONG_BATCH_SIZE) {
      await this.request("updatePlaylist", {
        playlistId: playlist.id,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
    return playlist;
  }

  async updatePlaylist(playlistId, { name, songIds = [] } = {}) {
    const playlist = await this.getPlaylist(playlistId);
    const entries = playlist?.entry
      ? Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry]
      : [];
    const ids = Array.isArray(songIds) ? songIds : [];
    await this.request("updatePlaylist", {
      playlistId,
      name,
      songIndexToRemove: entries.map((_, index) => index),
      songIdToAdd: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    for (let index = PLAYLIST_SONG_BATCH_SIZE; index < ids.length; index += PLAYLIST_SONG_BATCH_SIZE) {
      await this.request("updatePlaylist", {
        playlistId,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
  }

  async renamePlaylist(playlistId, name) {
    return this.request("updatePlaylist", { playlistId, name });
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

      const entries = Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry];
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
    if (!this._nativeTokenPromise) {
      this._nativeTokenPromise = axios.post(
        `${this.url}/auth/login`,
        { username: this.user, password: this.password },
        { headers: { "Content-Type": "application/json" } },
      ).then(({ data }) => {
        const token = data.token || data.Token;
        if (!token) throw new Error("No token in login response");
        return token;
      }).catch((error) => {
        this._nativeTokenPromise = null;
        throw error;
      });
    }
    return this._nativeTokenPromise;
  }

  async _nativeRequest(method, path, body = null) {
    const base = this.url;
    const url = path.startsWith("/") ? `${base}${path}` : `${base}/api/${path}`;
    let tokenRefreshes = 0;
    let rateLimitRetries = 0;
    for (;;) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin();
        tokenPromise = this._nativeTokenPromise || Promise.resolve(token);
      }
      const token = await tokenPromise;
      const headers = {
        "Content-Type": "application/json",
        "X-ND-Authorization": `Bearer ${token}`,
      };
      try {
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
        if (newToken) this._nativeTokenPromise = Promise.resolve(newToken);
        return response.data;
      } catch (error) {
        const status = error?.response?.status;
        if (status === 401 && tokenRefreshes === 0) {
          tokenRefreshes += 1;
          if (this._nativeTokenPromise === tokenPromise) this._nativeTokenPromise = null;
          continue;
        }
        if (status === 429 && rateLimitRetries < NAVIDROME_RATE_LIMIT_RETRIES) {
          const retryAfterHeader = error.response.headers?.["retry-after"]?.trim();
          const retryAfter = Number(retryAfterHeader);
          const delay = retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1000, NAVIDROME_RATE_LIMIT_MAX_DELAY_MS)
            : NAVIDROME_RATE_LIMIT_DELAY_MS;
          rateLimitRetries += 1;
          await wait(Math.max(0, delay));
          continue;
        }
        throw error;
      }
    }
  }

  async _requestPlaylistArtwork(method, playlistId, data, filename, contentType) {
    const url = `${this.url}/api/playlist/${encodeURIComponent(playlistId)}/image`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin();
        tokenPromise = this._nativeTokenPromise || Promise.resolve(token);
      }
      const token = await tokenPromise;
      const options = {
        method,
        headers: { "X-ND-Authorization": `Bearer ${token}` },
      };
      if (method === "POST") {
        const form = new FormData();
        form.append("image", new Blob([data], { type: contentType }), filename);
        options.body = form;
      }
      const response = await fetch(url, options);
      if (response.status === 401 && attempt === 0) {
        if (this._nativeTokenPromise === tokenPromise) this._nativeTokenPromise = null;
        continue;
      }
      if (!response.ok) {
        const action = method === "POST" ? "upload" : "deletion";
        throw new Error(`Playlist artwork ${action} failed with status ${response.status}`);
      }
      return;
    }
  }

  invalidateIndexedSongsCache() {
    this._indexedSongsPromise = null;
    this._indexedSongsAt = 0;
  }

  async _getIndexedSongs(force = false) {
    const now = Date.now();
    if (force || !this._indexedSongsPromise || now - (this._indexedSongsAt || 0) > 30000) {
      this._indexedSongsAt = now;
      this._indexedSongsPromise = (async () => {
        const songs = [];
        for (let start = 0; ; ) {
          const page = await this._nativeRequest(
            "GET",
            `/api/song?_start=${start}&_end=${start + NAVIDROME_SONG_PAGE_SIZE}`,
          );
          if (!Array.isArray(page) || page.length === 0) break;
          songs.push(...page);
          if (page.length < NAVIDROME_SONG_PAGE_SIZE) break;
          start += page.length;
        }
        return songs;
      })()
        .catch(() => {
          this._indexedSongsPromise = null;
          return [];
        });
    }
    return this._indexedSongsPromise;
  }

  async uploadPlaylistArtwork(playlistId, data, filename = "cover.webp", contentType = "image/webp") {
    return this._requestPlaylistArtwork(
      "POST",
      playlistId,
      data,
      filename,
      contentType,
    );
  }

  async deletePlaylistArtwork(playlistId) {
    return this._requestPlaylistArtwork("DELETE", playlistId);
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
      this._indexedSongsPromise = null;
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
    this._libraryPaths = [normalizedPath];
    try {
      const verifyLibrary = async (libraryId) => {
        const refreshed = await this.getLibraries();
        const list = Array.isArray(refreshed) ? refreshed : [];
        const byId = libraryId == null
          ? null
          : list.find((library) => String(library?.id || "") === String(libraryId));
        const verified = byId || list.find(
          (library) => normalizeLibraryPath(library?.path) === normalizedPath,
        );
        if (!verified || normalizeLibraryPath(verified.path) !== normalizedPath) {
          throw new Error(
            `Navidrome library path verification failed: expected ${normalizedPath}`,
          );
        }
        this._libraryPaths = [...new Set([
          normalizedPath,
          ...list.map((library) => normalizeLibraryPath(library.path)).filter(Boolean),
        ])];
        return verified;
      };
      const updateAndVerify = async (library) => {
        await this.updateLibrary(library.id, library);
        return verifyLibrary(library.id);
      };
      const libs = await this.getLibraries();
      const list = Array.isArray(libs) ? libs : [];
      this._libraryPaths = [...new Set([
        normalizedPath,
        ...list.map((lib) => normalizeLibraryPath(lib.path)).filter(Boolean),
      ])];
      const byPath = list.find((lib) => normalizeLibraryPath(lib.path) === normalizedPath);
      if (byPath) {
        if (byPath.name !== name) {
          return updateAndVerify({
            ...byPath,
            name,
            path: normalizedPath,
          });
        }
        return byPath;
      }

      const byName = list.find((lib) => lib.name === name || LEGACY_LIBRARY_NAMES.has(lib.name));
      if (byName) {
        if (normalizeLibraryPath(byName.path) !== normalizedPath) {
          return updateAndVerify({
            ...byName,
            name,
            path: normalizedPath,
          });
        }
        return byName;
      }

      const legacy = list.find((lib) => isLegacyPlaylistLibraryPath(lib.path));
      if (legacy) {
        return updateAndVerify({
          ...legacy,
          name,
          path: normalizedPath,
        });
      }

      const created = await this.createLibrary(name, normalizedPath);
      return verifyLibrary(created?.id);
    } catch (err) {
      const message = err?.response?.data?.error || err.message;
      if (err?.response?.status === 429) {
        logger.debug("navidrome", "Navidrome library setup was rate limited", { message });
      } else {
        logger.warn("navidrome", "Navidrome library setup failed", { message });
      }
      throw err;
    }
  }
}
