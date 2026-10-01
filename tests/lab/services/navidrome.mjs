import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

export function createNavidrome({ mediaRoot, media, username, password }) {
  const state = {
    libraries: [{ id: 1, name: "Music Library", path: mediaRoot }],
    playlists: [],
    nextLibraryId: 2,
    scans: 0,
  };
  const tokens = new Set();

  const subsonic = (body = {}) => ({
    status: 200,
    body: { "subsonic-response": { status: "ok", version: "1.16.1", type: "navidrome", serverVersion: "0.56.0-lab", openSubsonic: true, ...body } },
  });
  const failure = (code, message) => ({
    status: 200,
    body: { "subsonic-response": { status: "failed", version: "1.16.1", type: "navidrome", error: { code, message } } },
  });

  function libraryFor(file) {
    return [...state.libraries]
      .filter((library) => file === library.path || file.startsWith(`${library.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  const child = (song) => ({
    id: song.id,
    parent: createHash("sha1").update(path.dirname(song.path)).digest("hex").slice(0, 22),
    isDir: false,
    title: song.title,
    album: song.album,
    artist: song.artist,
    track: song.track,
    year: song.year || undefined,
    genre: song.genre || undefined,
    size: song.size,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: song.duration,
    bitRate: song.bitRate,
    path: song.path,
    musicBrainzId: song.musicBrainzId || undefined,
    type: "music",
    created: song.created,
  });

  const playlistJson = (playlist, withEntries) => {
    const songs = playlist.songIds.map((id) => media.get(id)).filter(Boolean);
    return {
      id: playlist.id,
      name: playlist.name,
      comment: playlist.comment || "",
      owner: username,
      public: playlist.public,
      songCount: songs.length,
      duration: songs.reduce((total, song) => total + song.duration, 0),
      created: playlist.created,
      changed: playlist.changed,
      ...(withEntries ? { entry: songs.map(child) } : {}),
    };
  };

  function importM3uFiles() {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.m3u8?$/i.test(entry.name)) files.push(full);
      }
    };
    for (const library of state.libraries) if (fs.existsSync(library.path)) walk(library.path);
    const songsByPath = new Map(media.songs(0).map((song) => [path.normalize(song.path), song]));
    for (const file of new Set(files)) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
      const songIds = lines
        .map((line) => songsByPath.get(path.normalize(path.isAbsolute(line) ? line : path.join(path.dirname(file), line))))
        .filter(Boolean)
        .map((song) => song.id);
      const comment = `Auto-imported from '${file}'`;
      const existing = state.playlists.find((playlist) => playlist.comment === comment);
      const now = new Date().toISOString();
      if (existing) Object.assign(existing, { songIds, changed: now });
      else {
        state.playlists.push({
          id: randomUUID(), name: path.basename(file, path.extname(file)), comment, public: false, songIds, created: now, changed: now,
        });
      }
    }
  }

  function authenticated(params) {
    if (params.get("u") !== username) return false;
    if (params.get("p")) return params.get("p").replace(/^enc:/, "") === password || Buffer.from(params.get("p").slice(4), "hex").toString() === password;
    const expected = createHash("md5").update(`${password}${params.get("s") || ""}`).digest("hex");
    return params.get("t") === expected;
  }

  function subsonicCall(endpoint, params) {
    if (!authenticated(params)) return failure(40, "Wrong username or password");
    const playlist = () => state.playlists.find((entry) => entry.id === (params.get("id") || params.get("playlistId")));
    switch (endpoint) {
      case "ping":
        return subsonic();
      case "getUser":
        return subsonic({ user: { username, email: "", adminRole: true, scrobblingEnabled: true, streamRole: true, playlistRole: true, downloadRole: true, folder: state.libraries.map((library) => library.id) } });
      case "getMusicFolders":
        return subsonic({ musicFolders: { musicFolder: state.libraries.map((library) => ({ id: library.id, name: library.name })) } });
      case "search3": {
        const count = Number(params.get("songCount") ?? 20);
        const songs = media.search(params.get("query")).slice(Number(params.get("songOffset") || 0), Number(params.get("songOffset") || 0) + count);
        return subsonic({ searchResult3: { song: songs.map(child) } });
      }
      case "getPlaylists":
        return subsonic({ playlists: { playlist: state.playlists.map((entry) => playlistJson(entry, false)) } });
      case "getPlaylist":
        return playlist() ? subsonic({ playlist: playlistJson(playlist(), true) }) : failure(70, "Playlist not found");
      case "createPlaylist": {
        const now = new Date().toISOString();
        const created = { id: randomUUID(), name: params.get("name") || "New playlist", comment: "", public: false, songIds: params.getAll("songId"), created: now, changed: now };
        state.playlists.push(created);
        return subsonic({ playlist: playlistJson(created, true) });
      }
      case "updatePlaylist": {
        const target = playlist();
        if (!target) return failure(70, "Playlist not found");
        if (params.has("name")) target.name = params.get("name");
        if (params.has("comment")) target.comment = params.get("comment");
        if (params.has("public")) target.public = params.get("public") === "true";
        const removed = new Set(params.getAll("songIndexToRemove").map(Number));
        target.songIds = target.songIds.filter((_id, index) => !removed.has(index)).concat(params.getAll("songIdToAdd"));
        target.changed = new Date().toISOString();
        return subsonic();
      }
      case "deletePlaylist":
        if (!playlist()) return failure(70, "Playlist not found");
        state.playlists = state.playlists.filter((entry) => entry !== playlist());
        return subsonic();
      case "startScan":
        media.scan();
        importM3uFiles();
        state.scans += 1;
        return subsonic({ scanStatus: { scanning: false, count: media.songs().length, folderCount: state.libraries.length } });
      case "getScanStatus":
        return subsonic({ scanStatus: { scanning: false, count: media.songs().length, folderCount: state.libraries.length } });
      case "getSong": {
        const song = media.get(params.get("id"));
        return song ? subsonic({ song: child(song) }) : failure(70, "Song not found");
      }
      case "stream":
      case "download": {
        const song = media.get(params.get("id"));
        if (!song) return failure(70, "Song not found");
        return { status: 200, raw: fs.readFileSync(song.path), headers: { "content-type": song.contentType } };
      }
      default:
        return null;
    }
  }

  function nativeCall({ method, url, headers, body }) {
    if (method === "POST" && url.pathname === "/auth/login") {
      if (body?.username !== username || body?.password !== password) return { status: 401, body: { error: "Invalid username or password" } };
      const token = randomUUID();
      tokens.add(token);
      return { status: 200, body: { id: "lab-admin", name: username, username, isAdmin: true, token } };
    }
    if (!url.pathname.startsWith("/api/")) return null;
    const token = String(headers["x-nd-authorization"] || "").replace(/^Bearer /, "");
    if (!tokens.has(token)) return { status: 401, body: { error: "Not authenticated" } };
    const [, , resource, id, part] = url.pathname.split("/");
    if (resource === "song" && method === "GET") {
      const songs = media.songs();
      const start = Number(url.searchParams.get("_start") || 0);
      const end = Number(url.searchParams.get("_end") || songs.length);
      return {
        status: 200,
        body: songs.slice(start, end).map((song) => ({ ...child(song), libraryId: libraryFor(song.path)?.id ?? 1, mbzRecordingID: song.musicBrainzId || undefined })),
        headers: { "x-total-count": String(songs.length) },
      };
    }
    if (resource === "library" && method === "GET" && !id) return { status: 200, body: state.libraries };
    if (resource === "library" && method === "POST" && !id) {
      const library = { id: state.nextLibraryId++, name: String(body?.name || "Library"), path: String(body?.path || "").replace(/\/+$/, "") };
      state.libraries.push(library);
      return { status: 200, body: library };
    }
    if (resource === "library" && method === "PUT" && id) {
      const library = state.libraries.find((entry) => String(entry.id) === id);
      if (!library) return { status: 404, body: { error: "Library not found" } };
      Object.assign(library, { name: body?.name ?? library.name, path: String(body?.path ?? library.path).replace(/\/+$/, "") });
      return { status: 200, body: library };
    }
    if (resource === "playlist" && id && part === "image") {
      const target = state.playlists.find((entry) => entry.id === id);
      if (!target) return { status: 404, body: { error: "Playlist not found" } };
      target.hasImage = method === "POST";
      return { status: 200, body: {} };
    }
    return null;
  }

  const handler = (request) => {
    const match = /^\/rest\/([A-Za-z0-9]+?)(?:\.view)?$/.exec(request.url.pathname);
    if (match) {
      const params = new URLSearchParams(request.url.searchParams);
      if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
        for (const [key, value] of Object.entries(request.body)) for (const item of asList(value)) params.append(key, item);
      }
      return subsonicCall(match[1], params);
    }
    return nativeCall(request);
  };
  handler.state = state;
  handler.restore = (saved) => Object.assign(state, saved);
  return handler;
}
