import axios from "../../lib/axiosFetch.js";
import crypto from "crypto";

const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PLAYLIST_LIBRARY_NAME = "Aurral Playlists";
const LEGACY_LIBRARY_NAMES = new Set(["Aurral Weekly Flow"]);
const PLAYLIST_SONG_BATCH_SIZE = 50;

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleForms(value) {
  const normalized = normalizeSearchText(value);
  const base = normalized.split(/\s+-\s+|\s+\(/, 1)[0].trim();
  return new Set([normalized, base].filter(Boolean));
}

function artistForms(value) {
  const normalized = normalizeSearchText(value);
  return new Set([normalized, normalized.replace(/^the\s+/, "")].filter(Boolean));
}

function stripTrackPrefix(value) {
  return String(value || "").replace(/^\s*\d{1,3}(?:[-_. ]+\d{1,3})?\s*[-_. ]+/, "");
}

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
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...this.getAuthParams(), ...params })) {
        if (Array.isArray(value)) {
          for (const item of value) query.append(key, item);
        } else if (value != null) {
          query.set(key, value);
        }
      }
      const response = await axios.get(`${this.url}/rest/${endpoint}?${query}`);

      if (response.data["subsonic-response"]?.status === "failed") {
        const responseError = response.data["subsonic-response"].error || {};
        const error = new Error(responseError.message || "Navidrome request failed");
        error.code = responseError.code;
        throw error;
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

  async findSong(title, artist, track = {}) {
    const normalizedPath = String(track.path || "").replace(/\\/g, "/").toLowerCase();
    if (normalizedPath) {
      const indexedSongs = await this._getIndexedSongs();
      const pathMatch = indexedSongs.find((song) => {
        const songPath = String(song.path || "").replace(/\\/g, "/").toLowerCase();
        return songPath && normalizedPath.endsWith(songPath);
      });
      if (pathMatch) return pathMatch;
    }
    const search = (query, songCount) => this.request("search3", {
      query,
      songCount,
      artistCount: 0,
      albumCount: 0,
    });
    const toList = (value) => {
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    };
    let data = await search(`${artist} ${title}`, 5);
    let songs = toList(data.searchResult3?.song);
    if (!songs.length) {
      data = await search(title, 25);
      songs = toList(data.searchResult3?.song);
    }
    if (!songs.length) {
      data = await search(artist, 25);
      songs = toList(data.searchResult3?.song);
    }
    const candidates = songs;
    const fileName = normalizedPath.split("/").at(-1);
    const album = String(track.album || "").toLowerCase();
    const mbid = String(track.mbid || "").toLowerCase();
    const duration = Number(track.durationMs) / 1000;
    const wantedTitles = titleForms(title);
    const wantedArtists = artistForms(artist);
    const wantedAlbum = normalizeSearchText(album);
    const wantedFileStem = normalizeSearchText(stripTrackPrefix(fileName?.replace(/\.[^.]+$/, "")));
    const score = (song) => {
      const songPath = String(song.path || "").replace(/\\/g, "/").toLowerCase();
      const candidateTitles = titleForms(song.title);
      const candidateArtists = artistForms(song.artist);
      const candidateAlbum = normalizeSearchText(song.album);
      const candidateFileStem = normalizeSearchText(
        stripTrackPrefix(songPath.split("/").at(-1)?.replace(/\.[^.]+$/, "")),
      );
      let value = 0;
      if (mbid && String(song.musicBrainzId || "").toLowerCase() === mbid) value += 8;
      if (songPath && normalizedPath.endsWith(songPath)) value += 8;
      else if (fileName && songPath.split("/").at(-1) === fileName) value += 4;
      if (wantedTitles.has(normalizeSearchText(song.title))) value += 10;
      else if ([...wantedTitles].some((form) => candidateTitles.has(form))) value += 7;
      if ([...wantedArtists].some((form) => candidateArtists.has(form))) value += 6;
      if (wantedAlbum && candidateAlbum === wantedAlbum) value += 3;
      if (wantedFileStem && candidateFileStem && (
        wantedFileStem === candidateFileStem
        || wantedFileStem.startsWith(candidateFileStem)
        || candidateFileStem.startsWith(wantedFileStem)
      )) value += 6;
      if (Number.isFinite(duration) && Math.abs(Number(song.duration) - duration) <= 2) value += 1;
      return value;
    };
    return candidates
      .map((song) => ({ song, score: score(song) }))
      .filter(({ score: value }) => value >= 13)
      .sort((a, b) => b.score - a.score)[0]?.song || null;
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

  async _getIndexedSongs() {
    if (!this._indexedSongsPromise) {
      this._indexedSongsPromise = this._nativeRequest("GET", "/api/song?_start=0&_end=100000")
        .then((songs) => (Array.isArray(songs) ? songs : []))
        .catch(() => []);
    }
    return this._indexedSongsPromise;
  }

  async uploadPlaylistArtwork(playlistId, data, filename = "cover.webp", contentType = "image/webp") {
    const token = await this._nativeLogin();
    const form = new FormData();
    form.append("image", new Blob([data], { type: contentType }), filename);
    const response = await fetch(
      `${this.url}/api/playlist/${encodeURIComponent(playlistId)}/image`,
      {
        method: "POST",
        headers: { "X-ND-Authorization": `Bearer ${token}` },
        body: form,
      },
    );
    if (!response.ok) {
      throw new Error(`Playlist artwork upload failed with status ${response.status}`);
    }
  }

  async deletePlaylistArtwork(playlistId) {
    const token = await this._nativeLogin();
    const response = await fetch(
      `${this.url}/api/playlist/${encodeURIComponent(playlistId)}/image`,
      {
        method: "DELETE",
        headers: { "X-ND-Authorization": `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Playlist artwork deletion failed with status ${response.status}`);
    }
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
    try {
      const libs = await this.getLibraries();
      const list = Array.isArray(libs) ? libs : [];
      const byPath = list.find((lib) => normalizeLibraryPath(lib.path) === normalizedPath);
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

      const byName = list.find((lib) => lib.name === name || LEGACY_LIBRARY_NAMES.has(lib.name));
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
