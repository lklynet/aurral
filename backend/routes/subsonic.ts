import path from "path";
import express, { type Request, type Response } from "express";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";

import { APP_NAME, APP_VERSION } from "../config/constants.ts";
import { hasPermission, resolveSubsonicTokenUser, resolveUser } from "../middleware/auth.ts";
import { getPlayQueue, savePlayQueue } from "../services/subsonicPlayQueueService.ts";
import { streamSubsonicAudio } from "../services/subsonicTranscodeService.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { getLyricsBySongId } from "../services/subsonicLyricsService.ts";
import { sendAudioFile } from "../services/audioFileStream.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";
import {
  findUniqueLibrarySong,
  getAlbum,
  getAlbumList,
  getArtist,
  getArtistInfo,
  getSubsonicPlaylist,
  getSubsonicPlaylists,
  getLibraryLastModified,
  getGenres,
  getMusicDirectory,
  getRandomSongs,
  getSong,
  getSongsByGenre,
  getStarred,
  getTopSongs,
  listArtists,
  createSubsonicPlaylist,
  deleteSubsonicPlaylist,
  resolveCustomArtwork,
  resolvePlaylistArtwork,
  resolveArtworkUrl,
  resolveStreamPath,
  searchLibrary,
  starMany,
  updateSubsonicPlaylist,
  unstarMany,
} from "../services/subsonicLibraryService.ts";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
} from "../services/libraryScanWorker.ts";
import { recordPlayEvent } from "../services/playEventService.ts";
import { logger } from "../services/logger.ts";
import { asAppError } from "../../lib/errors.ts";

const SUBSONIC_VERSION = "1.16.1";
const SUBSONIC_NAMESPACE = "http://subsonic.org/restapi";
const SUBSONIC_AUTH_HELP_URL = "https://docs.aurral.org/api/overview/";
const IGNORED_ARTICLES = "The El La Los Las Le Les";
// OpenSubsonic extensions this server implements, advertised by getOpenSubsonicExtensions.
const SUPPORTED_EXTENSIONS = [
  { name: "formPost", versions: [1] },
  { name: "topSongsByArtistId", versions: [1] },
  { name: "songLyrics", versions: [1] },
  { name: "transcodeOffset", versions: [1] },
];
type SubsonicFormat = "xml" | "json";
type SubsonicError = { code: number; message: string; helpUrl?: string };
type SubsonicParams = Record<string, unknown>;
type SubsonicFailure = [code: number, message: string, helpUrl?: string];
type SubsonicValidation = {
  format: SubsonicFormat;
  error?: SubsonicFailure;
  password?: string;
  token?: string;
  salt?: string;
};

const router = express.Router();

// OpenSubsonic formPost: parameters may arrive in a urlencoded body; query wins on conflicts.
const requestParameters = (req: Request): SubsonicParams => ({
  ...(req.body && typeof req.body === "object" ? req.body : {}),
  ...(req.query || {}),
});

const getParameter = (params: SubsonicParams, name: string) => {
  const value = params[name];
  return String(Array.isArray(value) ? value[0] || "" : value || "");
};

const getParameters = (params: SubsonicParams, names: string[]) =>
  names.flatMap((name) => {
    const value = params[name];
    return (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  });

const normalizeSearchQuery = (value: string) => {
  const query = String(value || "").trim();
  return query === '""' ? "" : query;
};

const escapeXml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function parseVersion(value: string) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

function decodePassword(value: string) {
  if (!value.startsWith("enc:")) return value;
  const encoded = value.slice(4);
  if (!/^(?:[a-f\d]{2})+$/i.test(encoded)) return null;
  return Buffer.from(encoded, "hex").toString("utf8");
}

function responseAttributes(status: "ok" | "failed") {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: APP_NAME,
    serverVersion: APP_VERSION,
    openSubsonic: true,
  };
}

const XML_OMIT_FIELDS = new Set(["albumArtists", "artists", "genres"]);

function renderXmlElement(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => renderXmlElement(name, entry)).join("");
  if (value == null) return "";
  if (typeof value !== "object") {
    return `<${name}>${escapeXml(value)}</${name}>`;
  }

  const text = Object.hasOwn(value, "value") ? Reflect.get(value, "value") : null;
  const attributes = [];
  const children = [];
  for (const [key, entry] of Object.entries(value)) {
    if (XML_OMIT_FIELDS.has(key) || key === "value") continue;
    if (entry == null || entry === undefined) continue;
    if (typeof entry === "object") children.push(renderXmlElement(key, entry));
    else attributes.push(`${key}="${escapeXml(entry)}"`);
  }
  const opening = `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  const body = [text == null ? "" : escapeXml(text), ...children].join("");
  return body ? `${opening}${body}</${name}>` : opening.slice(0, -1) + "/>";
}

function renderXml({
  status,
  data = {},
  error,
}: {
  status: "ok" | "failed";
  data?: Record<string, unknown>;
  error?: SubsonicError | null;
}) {
  const attributes = Object.entries(responseAttributes(status))
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(" ");
  const body = error
    ? renderXmlElement("error", error)
    : Object.entries(data)
        .map(([key, value]) => renderXmlElement(key, value))
        .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="${SUBSONIC_NAMESPACE}" ${attributes}>${body}</subsonic-response>`;
}

function renderResponse(
  format: SubsonicFormat,
  status: "ok" | "failed" = "ok",
  error: SubsonicError | null = null,
  data: Record<string, unknown> = {},
) {
  if (format === "xml") {
    return {
      contentType: "application/xml; charset=utf-8",
      body: renderXml({ status, data, error }),
    };
  }
  const payload = {
    "subsonic-response": {
      ...responseAttributes(status),
      ...(error ? { error } : data),
    },
  };
  return { contentType: "application/json; charset=utf-8", body: JSON.stringify(payload) };
}

function sendResponse(
  res: Response,
  format: SubsonicFormat,
  status: "ok" | "failed" = "ok",
  error: SubsonicError | null = null,
  data: Record<string, unknown> = {},
) {
  const { contentType, body } = renderResponse(format, status, error, data);
  return res.type(contentType).send(body);
}

const failedResponse = (format: SubsonicFormat, ...[code, message, helpUrl]: SubsonicFailure) =>
  renderResponse(format, "failed", { code, message, helpUrl });

function sendError(res: Response, format: SubsonicFormat, ...failure: SubsonicFailure) {
  const { contentType, body } = failedResponse(format, ...failure);
  return res.type(contentType).send(body);
}

const PLAYLIST_EDIT_ERROR_CODES: Partial<Record<string, number>> = {
  STATIC_PLAYLIST_NAME_CONFLICT: 50,
  SUBSONIC_PLAYLIST_READ_ONLY: 50,
  SUBSONIC_PLAYLIST_ENTRY_NOT_FOUND: 70,
};

function sendPlaylistEditError(res: Response, format: SubsonicFormat, error: unknown) {
  const failure = asAppError(error);
  const code = failure?.code === undefined ? undefined : PLAYLIST_EDIT_ERROR_CODES[failure.code];
  return failure === undefined || code === undefined
    ? sendError(res, format, 0, "Failed to update playlist")
    : sendError(res, format, code, failure.message);
}

function requestedFormat(params: SubsonicParams) {
  const format = getParameter(params, "f").toLowerCase() || "xml";
  return format === "xml" || format === "json" ? format : null;
}

function validateRequest(
  params: SubsonicParams,
  format: SubsonicFormat | null,
): SubsonicValidation {
  if (!format)
    return { format: "xml", error: [0, "Unsupported response format. Use xml or json."] };

  const apiKey = getParameter(params, "apiKey");
  for (const parameter of ["v", "c"]) {
    if (!getParameter(params, parameter)) {
      return { format, error: [10, `Required parameter is missing: ${parameter}`] };
    }
  }
  if (!apiKey && !getParameter(params, "u")) {
    return { format, error: [10, "Required parameter is missing: u"] };
  }

  const password = getParameter(params, "p");
  const token = getParameter(params, "t");
  const salt = getParameter(params, "s");
  const providedMechanisms =
    Number(Boolean(password)) + Number(Boolean(token || salt)) + Number(Boolean(apiKey));
  if (providedMechanisms > 1 || (apiKey && getParameter(params, "u"))) {
    return { format, error: [43, "Multiple conflicting authentication mechanisms provided"] };
  }
  if (apiKey) {
    return { format, error: [42, "API key authentication is not supported"] };
  }
  if (!password && !(token && salt)) {
    return { format, error: [10, "Required parameter is missing: p or t/s"] };
  }

  const version = parseVersion(getParameter(params, "v"));
  if (!version) {
    return {
      format,
      error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."],
    };
  }
  if (version.major > 1 || (version.major === 1 && version.minor > 16)) {
    return {
      format,
      error: [30, "Incompatible Subsonic REST protocol version. Server must upgrade."],
    };
  }
  if (version.major < 1) {
    return {
      format,
      error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."],
    };
  }

  return { format, password, token, salt };
}

const artistSortKey = (name: string) => {
  const value = String(name || "");
  const space = value.indexOf(" ");
  return space > 0 &&
    IGNORED_ARTICLES.split(" ").some(
      (article) => article.toLowerCase() === value.slice(0, space).toLowerCase(),
    )
    ? value.slice(space + 1)
    : value;
};

const groupArtists = <T extends { name: string }>(artists: T[]) => {
  const groups = new Map<string, T[]>();
  for (const artist of artists) {
    const name = artistSortKey(artist.name);
    const first = [...name][0] || "#";
    const key = /^\p{L}$/u.test(first) ? first.toUpperCase() : "#";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(artist);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === "#" ? 1 : b === "#" ? -1 : a < b ? -1 : 1))
    .map(([name, artist]) => ({
      name,
      artist: artist.sort((a, b) => artistSortKey(a.name).localeCompare(artistSortKey(b.name))),
    }));
};

function handleBinaryError(res: Response, message = "Requested media was not found") {
  return res.status(404).set("Content-Type", "text/plain; charset=utf-8").send(message);
}

function authenticate(params: SubsonicParams, method: string) {
  const validation = validateRequest(params, requestedFormat(params));
  if (validation.error) return { format: validation.format, error: validation.error };

  const { format, password, token, salt } = validation;
  const decodedPassword = password ? decodePassword(password) : null;
  const user = password
    ? decodedPassword == null
      ? null
      : resolveUser(getParameter(params, "u"), decodedPassword)
    : resolveSubsonicTokenUser(getParameter(params, "u"), token, salt);
  if (user) return { format, user };
  logger.debug("subsonic", "Authentication failed", {
    username: getParameter(params, "u"),
    method,
    authentication: password ? "password" : "token",
  });
  const error: SubsonicFailure = password
    ? [40, "Wrong username or password"]
    : [41, "Token authentication failed", SUBSONIC_AUTH_HELP_URL];
  return { format, error };
}

async function handleSubsonicRequest(req: Request, res: Response) {
  const params = requestParameters(req);
  const method = String(req.params.method || "")
    .replace(/\.view$/i, "")
    .toLowerCase();
  if (method === "getopensubsonicextensions") {
    // Must be reachable without any authentication parameters so clients can probe capabilities.
    const format = requestedFormat(params);
    if (!format) return sendError(res, "xml", 0, "Unsupported response format. Use xml or json.");
    return sendResponse(res, format, "ok", null, { openSubsonicExtensions: SUPPORTED_EXTENSIONS });
  }

  const auth = authenticate(params, String(req.params.method || ""));
  if (auth.error) return sendError(res, auth.format, ...auth.error);
  const { format, user } = auth;
  req.user = user;

  if (method === "ping") return sendResponse(res, format);
  if (method === "getuser") {
    const isAdmin = req.user.role === "admin";
    return sendResponse(res, format, "ok", null, {
      user: {
        username: req.user.username,
        adminRole: isAdmin,
        commentRole: false,
        coverArtRole: true,
        downloadRole: true,
        folder: [1],
        jukeboxRole: false,
        playlistRole: hasPermission(req.user, "accessFlow"),
        podcastRole: false,
        scrobblingEnabled: true,
        settingsRole: isAdmin,
        shareRole: false,
        streamRole: true,
        uploadRole: false,
        videoConversionRole: false,
      },
    });
  }
  if (method === "scrobble") {
    const ids = getParameters(params, ["id"]);
    if (ids.length === 0) return sendError(res, format, 10, "Required parameter is missing: id");
    const times = getParameters(params, ["time"]);
    const submission = !["false", "0", "no"].includes(
      getParameter(params, "submission").toLowerCase(),
    );
    if (submission) {
      ids.forEach((id, index) => {
        const song = getSong(id, user);
        if (!song) return;
        recordPlayEvent(user.id, {
          trackId: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          albumId: song.albumId,
          durationMs: Number(song.duration || 0) * 1000,
          playedAt: times[index] || undefined,
          source: "subsonic",
        });
      });
    }
    return sendResponse(res, format);
  }
  if (method === "getlicense") {
    return sendResponse(res, format, "ok", null, { license: { valid: true } });
  }
  if (method === "getmusicfolders") {
    return sendResponse(res, format, "ok", null, {
      musicFolders: { musicFolder: [{ id: 1, name: APP_NAME }] },
    });
  }
  if (method === "getscanstatus") {
    const jobId = getScheduledLibraryScanJobId();
    const status = jobId == null ? null : getLibraryScanStatus(jobId);
    return sendResponse(res, format, "ok", null, {
      scanStatus: {
        scanning: status?.status === "queued" || status?.status === "running",
      },
    });
  }
  if (method === "getnowplaying") {
    return sendResponse(res, format, "ok", null, { nowPlaying: { entry: [] } });
  }
  if (method === "getbookmarks") {
    return sendResponse(res, format, "ok", null, { bookmarks: { bookmark: [] } });
  }
  if (method === "saveplayqueue") {
    const position = getParameter(params, "position");
    if (position && (!/^\d+$/.test(position) || !Number.isSafeInteger(Number(position)))) {
      return sendError(res, format, 0, "position must be a nonnegative integer in milliseconds");
    }
    savePlayQueue(user, {
      ids: getParameters(params, ["id"]),
      current: getParameter(params, "current"),
      position: position ? Number(position) : null,
      changedBy: getParameter(params, "c"),
    });
    return sendResponse(res, format);
  }
  if (method === "getplayqueue") {
    return sendResponse(res, format, "ok", null, { playQueue: getPlayQueue(user) });
  }
  if (method === "getalbumlist" || method === "getalbumlist2") {
    const responseKey = method === "getalbumlist" ? "albumList" : "albumList2";
    return sendResponse(res, format, "ok", null, {
      [responseKey]: {
        album: getAlbumList(
          {
            fromYear: getParameter(params, "fromYear"),
            genre: getParameter(params, "genre"),
            offset: getParameter(params, "offset"),
            size: getParameter(params, "size"),
            toYear: getParameter(params, "toYear"),
            type: getParameter(params, "type"),
            musicFolderId: getParameter(params, "musicFolderId"),
          },
          user,
        ),
      },
    });
  }
  if (method === "getgenres") {
    return sendResponse(res, format, "ok", null, { genres: { genre: getGenres() } });
  }
  if (method === "getsongsbygenre") {
    const genre = getParameter(params, "genre").trim();
    if (!genre) return sendError(res, format, 10, "Required parameter is missing: genre");
    return sendResponse(res, format, "ok", null, {
      songsByGenre: {
        song: getSongsByGenre(
          genre,
          {
            count: getParameter(params, "count"),
            offset: getParameter(params, "offset"),
            musicFolderId: getParameter(params, "musicFolderId"),
          },
          user,
        ),
      },
    });
  }
  if (method === "getrandomsongs") {
    return sendResponse(res, format, "ok", null, {
      randomSongs: {
        song: getRandomSongs(
          {
            fromYear: getParameter(params, "fromYear"),
            genre: getParameter(params, "genre"),
            size: getParameter(params, "size"),
            toYear: getParameter(params, "toYear"),
            musicFolderId: getParameter(params, "musicFolderId"),
          },
          user,
        ),
      },
    });
  }
  if (method === "getartists") {
    return sendResponse(res, format, "ok", null, {
      artists: { ignoredArticles: IGNORED_ARTICLES, index: groupArtists(listArtists(user)) },
    });
  }
  if (method === "getindexes") {
    const lastModified = getLibraryLastModified(user);
    const ifModifiedSince = Number.parseInt(getParameter(params, "ifModifiedSince"), 10);
    const unchanged = Number.isFinite(ifModifiedSince) && ifModifiedSince >= lastModified;
    return sendResponse(res, format, "ok", null, {
      indexes: {
        ignoredArticles: IGNORED_ARTICLES,
        lastModified,
        ...(unchanged ? {} : { index: groupArtists(listArtists(user)) }),
      },
    });
  }
  if (method === "getartist") {
    const artist = getArtist(getParameter(params, "id"), user);
    return artist
      ? sendResponse(res, format, "ok", null, { artist })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getartistinfo") {
    const artistInfo = getArtistInfo(getParameter(params, "id"));
    return artistInfo
      ? sendResponse(res, format, "ok", null, { artistInfo })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getartistinfo2") {
    const artistInfo2 = getArtistInfo(getParameter(params, "id"));
    return artistInfo2
      ? sendResponse(res, format, "ok", null, { artistInfo2 })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getalbuminfo" || method === "getalbuminfo2") {
    return getAlbum(getParameter(params, "id"))
      ? sendResponse(res, format, "ok", null, { albumInfo: {} })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getlyricsbysongid") {
    const id = getParameter(params, "id");
    if (!id) return sendError(res, format, 10, "Required parameter is missing: id");
    return sendResponse(res, format, "ok", null, {
      lyricsList: { structuredLyrics: await getLyricsBySongId(id, user) },
    });
  }
  if (method === "getlyrics") {
    const song = findUniqueLibrarySong(
      getParameter(params, "artist"),
      getParameter(params, "title"),
      user,
    );
    const lyrics = song ? await getLyricsBySongId(song.id, user) : [];
    return sendResponse(res, format, "ok", null, {
      lyrics: {
        ...(song && lyrics.length ? { artist: song.artist, title: song.title } : {}),
        value: lyrics[0]?.line.map((line) => line.value).join("\n") || "",
      },
    });
  }
  if (method === "getinternetradiostations") {
    return sendResponse(res, format, "ok", null, {
      internetRadioStations: { internetRadioStation: [] },
    });
  }
  if (method === "getpodcasts") {
    return sendResponse(res, format, "ok", null, { podcasts: { channel: [] } });
  }
  if (method === "getsimilarsongs" || method === "getsimilarsongs2") {
    const key = method === "getsimilarsongs" ? "similarSongs" : "similarSongs2";
    return sendResponse(res, format, "ok", null, { [key]: { song: [] } });
  }
  if (method === "getalbum") {
    const album = getAlbum(getParameter(params, "id"), user);
    return album
      ? sendResponse(res, format, "ok", null, { album })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getsong") {
    const song = getSong(getParameter(params, "id"), user);
    return song
      ? sendResponse(res, format, "ok", null, { song })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getmusicdirectory") {
    const directory = getMusicDirectory(getParameter(params, "id"), user);
    return directory
      ? sendResponse(res, format, "ok", null, { directory })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "search3" || method === "search2") {
    const query = normalizeSearchQuery(getParameter(params, "query"));
    return sendResponse(res, format, "ok", null, {
      [method === "search3" ? "searchResult3" : "searchResult2"]: searchLibrary(
        query,
        params,
        user,
      ),
    });
  }
  if (method === "getplaylists") {
    return sendResponse(res, format, "ok", null, {
      playlists: { playlist: getSubsonicPlaylists(user) },
    });
  }
  if (method === "createplaylist") {
    const playlistId = getParameter(params, "playlistId");
    const name = getParameter(params, "name");
    if (!playlistId && !name) {
      return sendError(res, format, 10, "Required parameter is missing: name");
    }
    try {
      const playlist = playlistId
        ? await updateSubsonicPlaylist(user, {
            playlistId,
            name: name || undefined,
            comment: Object.hasOwn(params, "comment") ? getParameter(params, "comment") : undefined,
            songIds: getParameters(params, ["songId"]),
          })
        : await createSubsonicPlaylist(user, {
            name,
            songIds: getParameters(params, ["songId"]),
          });
      if (!playlist) return sendError(res, format, 70, "Requested data was not found");
      return sendResponse(res, format, "ok", null, {
        playlist: getSubsonicPlaylist(`shared:${encodeURIComponent(playlist.id)}`, user),
      });
    } catch (error) {
      return sendPlaylistEditError(res, format, error);
    }
  }
  if (method === "getstarred" || method === "getstarred2") {
    return sendResponse(res, format, "ok", null, {
      [method === "getstarred" ? "starred" : "starred2"]: getStarred(user),
    });
  }
  if (method === "star" || method === "unstar") {
    const targets = getParameters(params, ["id", "albumId", "artistId"]);
    const changed = method === "star" ? starMany(user, targets) : unstarMany(user, targets);
    return changed
      ? sendResponse(res, format)
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "gettopsongs") {
    // OpenSubsonic topSongsByArtistId: an artist id takes precedence over the artist name.
    const artistId = getParameter(params, "id");
    const resolvedArtist = artistId ? getArtist(artistId) : null;
    if (artistId && !resolvedArtist)
      return sendError(res, format, 70, "Requested data was not found");
    const artist = resolvedArtist?.name || String(getParameter(params, "artist") || "").trim();
    if (!artist) return sendError(res, format, 10, "Required parameter is missing: artist");
    return sendResponse(res, format, "ok", null, {
      topSongs: {
        song: getTopSongs(artist, { count: getParameter(params, "count") }, user),
      },
    });
  }
  if (method === "getplaylist") {
    const playlist = getSubsonicPlaylist(getParameter(params, "id"), user);
    return playlist
      ? sendResponse(res, format, "ok", null, { playlist })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "updateplaylist") {
    const playlistId = getParameter(params, "playlistId");
    if (!playlistId) return sendError(res, format, 10, "Required parameter is missing: playlistId");
    const songIndexesToRemove = getParameters(params, ["songIndexToRemove"]).map((value) =>
      /^\d+$/.test(value) ? Number(value) : value,
    );
    try {
      const playlist = await updateSubsonicPlaylist(user, {
        playlistId,
        name: Object.hasOwn(params, "name") ? getParameter(params, "name") : undefined,
        comment: Object.hasOwn(params, "comment") ? getParameter(params, "comment") : undefined,
        songIdsToAdd: getParameters(params, ["songIdToAdd"]),
        songIndexesToRemove,
      });
      return playlist
        ? sendResponse(res, format)
        : sendError(res, format, 70, "Requested data was not found");
    } catch (error) {
      return sendPlaylistEditError(res, format, error);
    }
  }
  if (method === "deleteplaylist") {
    const playlistId = getParameter(params, "id");
    if (!playlistId) return sendError(res, format, 10, "Required parameter is missing: id");
    try {
      return (await deleteSubsonicPlaylist(user, playlistId))
        ? sendResponse(res, format)
        : sendError(res, format, 70, "Requested data was not found");
    } catch {
      return sendError(res, format, 0, "Failed to delete playlist");
    }
  }
  if (method === "download") {
    const filePath = resolveStreamPath(getParameter(params, "id"), user);
    if (!filePath) return handleBinaryError(res, "Track file missing");
    return (await sendAudioFile(req, res, filePath))
      ? undefined
      : handleBinaryError(res, "Track file missing");
  }
  if (method === "getcoverart") {
    const customArtwork = resolveCustomArtwork(getParameter(params, "id"), user);
    if (customArtwork) {
      res.type(customArtwork.contentType);
      res.set("Cache-Control", "private, max-age=31536000, immutable");
      return res.sendFile(path.basename(customArtwork.filePath), {
        root: path.dirname(customArtwork.filePath),
        dotfiles: "deny",
      });
    }
    const playlistArtwork = await resolvePlaylistArtwork(getParameter(params, "id"), user);
    if (playlistArtwork) {
      res.set("Cache-Control", "private, max-age=86400");
      return res.sendFile(path.basename(playlistArtwork.safePath), {
        root: path.dirname(playlistArtwork.safePath),
        dotfiles: "allow",
      });
    }
    const artworkUrl = await resolveArtworkUrl(getParameter(params, "id"));
    if (!artworkUrl) return handleBinaryError(res, "Cover art not found");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.redirect(302, artworkUrl);
  }
  return sendError(res, format, 0, `Unsupported request: ${method}`);
}

router.all("/:method", handleSubsonicRequest);
router.use((_req, res) => sendError(res, "xml", 0, "Unsupported request"));

const streamFormat = v.pipe(
  v.string(),
  v.toLowerCase(),
  v.picklist(["", "raw", "mp3", "opus", "aac"]),
);
const streamBitRate = v.pipe(
  v.string(),
  v.regex(/^\d*$/),
  v.transform(Number),
  v.check((kbps) => Number.isSafeInteger(kbps) && (kbps === 0 || kbps >= 8)),
);
const streamOffset = v.pipe(
  v.string(),
  v.transform(Number),
  v.check((seconds) => Number.isFinite(seconds) && seconds >= 0),
);

const formParameters = (c: Context<AppEnv>) =>
  c.req.header("content-type")?.includes("application/x-www-form-urlencoded")
    ? c.req.parseBody({ all: true })
    : {};

export const subsonicStream = new Hono<AppEnv>()
  .basePath("/rest")
  .all("/:method", bodyLimit({ maxSize: 100 * 1024 }), async (c) => {
    const params: SubsonicParams = { ...(await formParameters(c)), ...c.req.queries() };
    const reply = ({ contentType, body }: ReturnType<typeof renderResponse>) =>
      c.body(body, 200, { "Content-Type": contentType });
    const missing = () =>
      c.body("Track file missing", 404, { "Content-Type": "text/plain; charset=utf-8" });

    const auth = authenticate(params, c.req.param("method"));
    if (auth.error) return reply(failedResponse(auth.format, ...auth.error));
    const { format, user } = auth;
    const filePath = resolveStreamPath(getParameter(params, "id"), user);
    if (!filePath) return missing();

    const outputFormat = v.safeParse(streamFormat, getParameter(params, "format"));
    if (!outputFormat.success) {
      return reply(failedResponse(format, 0, "Unsupported audio format"));
    }
    const maxBitRate = v.safeParse(streamBitRate, getParameter(params, "maxBitRate"));
    if (!maxBitRate.success) {
      return reply(failedResponse(format, 0, "maxBitRate must be zero or at least 8 kbps"));
    }
    const timeOffset = v.safeParse(streamOffset, getParameter(params, "timeOffset"));
    if (!timeOffset.success) {
      return reply(failedResponse(format, 0, "timeOffset must be a nonnegative number of seconds"));
    }

    const sent = await sendViaNode(c, streamSubsonicAudio, filePath, {
      format: outputFormat.output,
      maxBitRate: maxBitRate.output,
      timeOffset: timeOffset.output,
    });
    return sent || missing();
  });

export { groupArtists, renderXmlElement };
export default router;
