import { setTimeout as wait } from "node:timers/promises";
import axios from "../../lib/axiosFetch.ts";
import crypto from "crypto";
import { logger } from "./logger.ts";
import { requirePlaylistPath, isAbsoluteMediaPath } from "./playback/playlistUsage.ts";

const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PLAYLIST_LIBRARY_NAME = "Aurral Playlists";
const LEGACY_LIBRARY_NAMES = new Set(["Aurral Weekly Flow"]);
const PLAYLIST_SONG_BATCH_SIZE = 50;
const NAVIDROME_SONG_LOOKUP_LIMIT = 100;
const NAVIDROME_SONG_PATH_FILTER_MINOR_VERSION = 62;
const NAVIDROME_SONG_CACHE_TTL_MS = 10 * 60_000;
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

type NavidromeSong = {
  id: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  path?: string | null;
  libraryPath?: string | null;
  mbzRecordingID?: string | null;
  duration?: number | null;
};

type NavidromeTrackRef = {
  path?: string | null;
  mbid?: string | null;
  title?: string | null;
  trackName?: string | null;
  artist?: string | null;
  artistName?: string | null;
  album?: string | null;
  albumName?: string | null;
};

type NavidromePlaylistEntry = { id: string; path: string };

type NavidromePlaylist = {
  id: string;
  songCount?: number;
  entry?: NavidromePlaylistEntry | NavidromePlaylistEntry[];
};

export type NavidromeLibrary = { id: string | number; name: string; path: string };

type NavidromeParams = Record<
  string,
  string | number | boolean | (string | number)[] | null | undefined
>;

type NavidromeSubsonicResponse = {
  status?: string;
  error?: { code?: number; message?: string };
  serverVersion?: string;
  user?: { adminRole?: boolean };
  playlists?: { playlist?: NavidromePlaylist | NavidromePlaylist[] };
  playlist?: NavidromePlaylist;
  searchResult3?: { song?: NavidromeSong | NavidromeSong[] };
  scanStatus?: { scanning?: boolean };
};

function normalizeLibraryPath(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isLegacyPlaylistLibraryPath(value: unknown) {
  const libraryPath = normalizeLibraryPath(value);
  return libraryPath.endsWith(`/${LEGACY_LIBRARY_DIR}`) || libraryPath === LEGACY_LIBRARY_DIR;
}

function normalizeMatchText(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function songFilePath(song: NavidromeSong) {
  return `${normalizeLibraryPath(song.libraryPath)}/${normalizeLibraryPath(song.path)}`.toLowerCase();
}

function supportsSongPathFilter(serverVersion: unknown) {
  const match = /(\d+)\.(\d+)/.exec(String(serverVersion || ""));
  if (!match) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= NAVIDROME_SONG_PATH_FILTER_MINOR_VERSION;
}

export class NavidromeClient {
  declare url: string | null;
  declare user: string;
  declare password: string;
  declare _libraryPaths: string[];
  declare _nativeTokenPromise: Promise<string> | null;
  declare _songPathFilter: { supported: Promise<boolean>; expiresAt: number } | null;
  declare _songsByFile: Map<string, { song: NavidromeSong; expiresAt: number }>;

  constructor(url: string | null | undefined, user: string, password: string) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.user = user;
    this.password = password;
    this._libraryPaths = [];
    this._nativeTokenPromise = null;
    this._songPathFilter = null;
    this._songsByFile = new Map();
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

  async request(
    endpoint: string,
    params: NavidromeParams = {},
    { timeout = 0 }: { timeout?: number } = {},
  ): Promise<NavidromeSubsonicResponse> {
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
          const response =
            endpoint === "updatePlaylist"
              ? await axios.post(endpointUrl, query, { preserveMethodOnRedirect: true })
              : await axios.get(`${endpointUrl}?${query}`, { timeout });

          if (response.data["subsonic-response"]?.status === "failed") {
            const responseError = response.data["subsonic-response"].error || {};
            const error: Error & { code?: number } = new Error(
              responseError.message || "Navidrome request failed",
            );
            error.code = responseError.code;
            throw error;
          }

          return response.data["subsonic-response"];
        } catch (error) {
          const isNetworkFailure = error instanceof TypeError && !error?.response;
          if (isNetworkFailure) {
            if (
              !NAVIDROME_RETRYABLE_READ_ENDPOINTS.has(endpoint) ||
              attempt >= NAVIDROME_NETWORK_RETRIES
            ) {
              throw error;
            }
            await wait(NAVIDROME_RATE_LIMIT_DELAY_MS);
            continue;
          }
          if (!error?.response) throw error;
          if (error.response.status !== 429 || attempt >= NAVIDROME_RATE_LIMIT_RETRIES) throw error;
          const retryAfterHeader = error.response.headers?.["retry-after"]?.trim();
          const retryAfter = Number(retryAfterHeader);
          const delay =
            retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
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

  async findSong(
    title: string | null | undefined,
    artist: string | null | undefined,
    track: NavidromeTrackRef = {},
  ) {
    const trackFile = normalizeLibraryPath(track.path).toLowerCase();
    const cached = this._songsByFile.get(trackFile);
    if (cached?.expiresAt > Date.now()) return cached.song;
    const song = await this._lookUpSong(title, artist, track);
    if (song && songFilePath(song) === trackFile) this._rememberSong(trackFile, song);
    return song;
  }

  _rememberSong(trackFile: string, song: NavidromeSong) {
    const now = Date.now();
    for (const [cachedFile, entry] of this._songsByFile) {
      if (entry.expiresAt > now) break;
      this._songsByFile.delete(cachedFile);
    }
    this._songsByFile.delete(trackFile);
    this._songsByFile.set(trackFile, { song, expiresAt: now + NAVIDROME_SONG_CACHE_TTL_MS });
  }

  async _lookUpSong(
    title: string | null | undefined,
    artist: string | null | undefined,
    track: NavidromeTrackRef,
  ) {
    const trackPath = normalizeLibraryPath(track.path);
    const matchPath = trackPath.toLowerCase();
    const isTrackFile = (song: NavidromeSong) => songFilePath(song) === matchPath;
    const mbid = normalizeMatchText(track.mbid);
    const mbidMatches: NavidromeSong[] = mbid
      ? (await this._searchSongs({ mbz_recording_id: mbid })).songs.filter(
          (song) => normalizeMatchText(song.mbzRecordingID) === mbid,
        )
      : [];
    const mbidFileMatch = mbidMatches.find(isTrackFile);
    if (mbidFileMatch) return mbidFileMatch;

    const libraryPaths = this._libraryPaths
      .map(normalizeLibraryPath)
      .filter(
        (libraryPath) => libraryPath && matchPath.startsWith(`${libraryPath.toLowerCase()}/`),
      );
    if (libraryPaths.length && (await this._canFilterSongsByPath())) {
      for (const libraryPath of libraryPaths) {
        const { songs } = await this._searchSongs({
          path: trackPath.slice(libraryPath.length + 1),
        });
        const pathMatch = songs.find(isTrackFile);
        if (pathMatch) return pathMatch;
      }
    }
    if (mbidMatches.length) return mbidMatches[0];

    const cleanTitle = normalizeMatchText(title || track.title || track.trackName);
    const cleanArtist = normalizeMatchText(artist || track.artist || track.artistName);
    if (!cleanTitle || !cleanArtist) return null;
    const searchText = `${cleanTitle} ${cleanArtist}`
      .split(/\s+/)
      .filter((word) => !word.includes("*"))
      .join(" ");
    if (!searchText) return null;
    const { songs, complete } = await this._searchSongs({ title: searchText });
    const titleFileMatch = songs.find(isTrackFile);
    if (titleFileMatch) return titleFileMatch;
    if (!complete) return null;
    const candidateMatches = songs.filter(
      (song) =>
        normalizeMatchText(song.title) === cleanTitle &&
        normalizeMatchText(song.artist) === cleanArtist,
    );
    if (candidateMatches.length === 1) return candidateMatches[0];
    const cleanAlbum = normalizeMatchText(track.album || track.albumName);
    if (candidateMatches.length > 1 && cleanAlbum) {
      const albumMatches = candidateMatches.filter(
        (song) => normalizeMatchText(song.album) === cleanAlbum,
      );
      if (albumMatches.length === 1) return albumMatches[0];
    }
    return null;
  }

  _canFilterSongsByPath() {
    const now = Date.now();
    if (!(this._songPathFilter?.expiresAt > now)) {
      const supported: Promise<boolean> = this.ping()
        .then((response) => supportsSongPathFilter(response?.serverVersion))
        .catch((error) => {
          if (this._songPathFilter?.supported === supported) this._songPathFilter = null;
          throw error;
        });
      this._songPathFilter = { supported, expiresAt: now + NAVIDROME_SONG_CACHE_TTL_MS };
    }
    return this._songPathFilter!.supported;
  }

  async _searchSongs(filters: Record<string, string>) {
    const query = new URLSearchParams({
      ...filters,
      missing: "false",
      _start: "0",
      _end: String(NAVIDROME_SONG_LOOKUP_LIMIT),
    });
    const page = await this._nativeRequest("GET", `/api/song?${query}`);
    const songs: NavidromeSong[] = Array.isArray(page) ? page : [];
    return { songs, complete: songs.length < NAVIDROME_SONG_LOOKUP_LIMIT };
  }

  async searchSongsByArtist(artistName: string, limit = 5) {
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

  getStreamUrl(songId: string) {
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

  async getPlaylistTrackPaths(excludedIds: Set<string> = new Set<string>()) {
    const account = await this.request("getUser", { username: this.user }, { timeout: 30_000 });
    if (account?.user?.adminRole !== true) {
      throw new Error(
        "Navidrome playlist protection requires an admin account to see private playlists",
      );
    }
    const data = await this.request("getPlaylists", {}, { timeout: 30_000 });
    if (!data?.playlists || typeof data.playlists !== "object" || Array.isArray(data.playlists)) {
      throw new Error("Invalid Navidrome playlist list");
    }
    const rawPlaylists = data.playlists.playlist ?? [];
    const playlists = Array.isArray(rawPlaylists) ? rawPlaylists : [rawPlaylists];
    const paths = new Set<string>();
    let libraries: NavidromeLibrary[] | undefined;
    for (const playlist of playlists) {
      if (!playlist?.id) throw new Error("Navidrome playlist is missing its ID");
      if (excludedIds.has(String(playlist.id))) continue;
      const detail = (await this.request("getPlaylist", { id: playlist.id }, { timeout: 30_000 }))
        ?.playlist;
      const rawEntries = detail?.entry ?? [];
      const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
      if (
        !detail ||
        !Number.isSafeInteger(detail.songCount) ||
        entries.length !== detail.songCount
      ) {
        throw new Error("Incomplete Navidrome playlist contents");
      }
      for (const entry of entries) {
        const file = requirePlaylistPath(entry.path);
        if (isAbsoluteMediaPath(file)) {
          paths.add(file);
          continue;
        }
        libraries ??= await this.getLibraries({ timeout: 30_000 });
        if (!Array.isArray(libraries) || !libraries.length) {
          throw new Error("Cannot resolve Navidrome playlist track paths");
        }
        // Subsonic paths may be relative and omit the library ID. Protect all
        // possible library roots rather than guess which copy is referenced.
        for (const library of libraries) paths.add(`${requirePlaylistPath(library.path)}/${file}`);
      }
    }
    return [...paths];
  }

  async getPlaylist(id: string) {
    const data = await this.request("getPlaylist", { id });
    return data.playlist || null;
  }

  async createPlaylist(name: string, songIds: string[]) {
    const ids = Array.isArray(songIds) ? songIds : [];
    const data = await this.request("createPlaylist", {
      name,
      songId: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    const playlist = data.playlist || null;
    if (!playlist?.id) return playlist;
    await this.request("updatePlaylist", {
      playlistId: playlist.id,
      public: true,
    });
    for (
      let index = PLAYLIST_SONG_BATCH_SIZE;
      index < ids.length;
      index += PLAYLIST_SONG_BATCH_SIZE
    ) {
      await this.request("updatePlaylist", {
        playlistId: playlist.id,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
    return playlist;
  }

  async updatePlaylist(
    playlistId: string,
    { name, songIds = [] }: { name?: string; songIds?: string[] } = {},
  ) {
    const playlist = await this.getPlaylist(playlistId);
    const entries = playlist?.entry
      ? Array.isArray(playlist.entry)
        ? playlist.entry
        : [playlist.entry]
      : [];
    const ids = Array.isArray(songIds) ? songIds : [];
    await this.request("updatePlaylist", {
      playlistId,
      name,
      songIndexToRemove: entries.map((_, index) => index),
      songIdToAdd: ids.slice(0, PLAYLIST_SONG_BATCH_SIZE),
    });
    for (
      let index = PLAYLIST_SONG_BATCH_SIZE;
      index < ids.length;
      index += PLAYLIST_SONG_BATCH_SIZE
    ) {
      await this.request("updatePlaylist", {
        playlistId,
        songIdToAdd: ids.slice(index, index + PLAYLIST_SONG_BATCH_SIZE),
      });
    }
  }

  async renamePlaylist(playlistId: string, name: string) {
    return this.request("updatePlaylist", { playlistId, name });
  }

  async deletePlaylist(id: string) {
    return this.request("deletePlaylist", { id });
  }

  async addToPlaylist(playlistId: string, songId: string) {
    return this.request("updatePlaylist", {
      playlistId,
      songIdToAdd: songId,
    });
  }

  async removeFromPlaylist(playlistId: string, songId: string) {
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

  async _nativeLogin({ timeout = 0 }: { timeout?: number } = {}) {
    if (!this.isConfigured()) throw new Error("Navidrome not configured");
    if (!this._nativeTokenPromise) {
      this._nativeTokenPromise = axios
        .post(
          `${this.url}/auth/login`,
          { username: this.user, password: this.password },
          { headers: { "Content-Type": "application/json" }, timeout },
        )
        .then(({ data }) => {
          const token = data.token || data.Token;
          if (!token) throw new Error("No token in login response");
          return token;
        })
        .catch((error) => {
          this._nativeTokenPromise = null;
          throw error;
        });
    }
    return this._nativeTokenPromise;
  }

  async _nativeRequest(
    method: string,
    path: string,
    body: unknown = null,
    { timeout = 0 }: { timeout?: number } = {},
  ) {
    const base = this.url;
    const url = path.startsWith("/") ? `${base}${path}` : `${base}/api/${path}`;
    let tokenRefreshes = 0;
    let rateLimitRetries = 0;
    for (;;) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin({ timeout });
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
          response = await axios.get(url, { headers, timeout });
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
          const delay =
            retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0
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

  async _requestPlaylistArtwork(
    method: string,
    playlistId: string,
    data?: Uint8Array,
    filename?: string,
    contentType?: string,
  ) {
    const url = `${this.url}/api/playlist/${encodeURIComponent(playlistId)}/image`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let tokenPromise = this._nativeTokenPromise;
      if (!tokenPromise) {
        const token = await this._nativeLogin();
        tokenPromise = this._nativeTokenPromise || Promise.resolve(token);
      }
      const token = await tokenPromise;
      const options: { method: string; headers: Record<string, string>; body?: FormData } = {
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

  async uploadPlaylistArtwork(
    playlistId: string,
    data: Uint8Array,
    filename = "cover.webp",
    contentType = "image/webp",
  ) {
    return this._requestPlaylistArtwork("POST", playlistId, data, filename, contentType);
  }

  async deletePlaylistArtwork(playlistId: string) {
    return this._requestPlaylistArtwork("DELETE", playlistId);
  }

  async getLibraries(options: { timeout?: number } = {}): Promise<NavidromeLibrary[]> {
    return this._nativeRequest("GET", "/api/library", null, options);
  }

  async createLibrary(name: string, path: string): Promise<NavidromeLibrary> {
    return this._nativeRequest("POST", "/api/library", { name, path });
  }

  async updateLibrary(id: string | number, payload: NavidromeLibrary) {
    return this._nativeRequest("PUT", `/api/library/${id}`, payload);
  }

  async isScanning() {
    return (await this.request("getScanStatus"))?.scanStatus?.scanning === true;
  }

  async scanLibrary(targets: string | string[] | null = null) {
    if (!this.isConfigured()) return null;
    return this.request("startScan", targets ? { target: targets } : {});
  }

  async ensureAurralLibrary(libraryPath: string) {
    if (!this.isConfigured()) return null;
    const name = PLAYLIST_LIBRARY_NAME;
    const normalizedPath = normalizeLibraryPath(libraryPath);
    this._libraryPaths = [normalizedPath];
    try {
      const verifyLibrary = async (libraryId: string | number | null | undefined) => {
        const refreshed = await this.getLibraries();
        const list = Array.isArray(refreshed) ? refreshed : [];
        const byId =
          libraryId == null
            ? null
            : list.find((library) => String(library?.id || "") === String(libraryId));
        const verified =
          byId || list.find((library) => normalizeLibraryPath(library?.path) === normalizedPath);
        if (!verified || normalizeLibraryPath(verified.path) !== normalizedPath) {
          throw new Error(`Navidrome library path verification failed: expected ${normalizedPath}`);
        }
        this._libraryPaths = [
          ...new Set([
            normalizedPath,
            ...list.map((library) => normalizeLibraryPath(library.path)).filter(Boolean),
          ]),
        ];
        return verified;
      };
      const updateAndVerify = async (library: NavidromeLibrary) => {
        await this.updateLibrary(library.id, library);
        return verifyLibrary(library.id);
      };
      const libs = await this.getLibraries();
      const list = Array.isArray(libs) ? libs : [];
      this._libraryPaths = [
        ...new Set([
          normalizedPath,
          ...list.map((lib) => normalizeLibraryPath(lib.path)).filter(Boolean),
        ]),
      ];
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
