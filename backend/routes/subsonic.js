import express from "express";

import { APP_NAME, APP_VERSION } from "../config/constants.js";
import { resolveSubsonicTokenUser, resolveUser } from "../middleware/auth.js";
import { streamAudioFile } from "../services/audioFileStream.js";
import {
  getAlbum,
  getAlbumList,
  getArtist,
  getArtistInfo,
  getFlowPlaylist,
  getFlowPlaylists,
  getGenres,
  getMusicDirectory,
  getSong,
  getSongsByGenre,
  getStarred,
  getTopSongs,
  listArtists,
  resolvePlaylistArtwork,
  resolveArtworkUrl,
  resolveStreamPath,
  searchLibrary,
  starMany,
  unstarMany,
} from "../services/subsonicLibraryService.js";

const SUBSONIC_VERSION = "1.16.1";
const SUBSONIC_NAMESPACE = "http://subsonic.org/restapi";
const router = express.Router();

const getParameter = (req, name) => {
  const value = req.query?.[name];
  return String(Array.isArray(value) ? value[0] || "" : value || "");
};

const getParameters = (req, names) =>
  names.flatMap((name) => {
    const value = req.query?.[name];
    return (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  });

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

function decodePassword(value) {
  if (!value.startsWith("enc:")) return value;
  const encoded = value.slice(4);
  if (!/^(?:[a-f\d]{2})+$/i.test(encoded)) return null;
  return Buffer.from(encoded, "hex").toString("utf8");
}

function responseAttributes(status) {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: APP_NAME,
    serverVersion: APP_VERSION,
  };
}

const XML_OMIT_FIELDS = new Set(["albumArtists", "artists", "genres"]);

function renderXmlElement(name, value) {
  if (Array.isArray(value)) return value.map((entry) => renderXmlElement(name, entry)).join("");
  if (value == null) return "";
  if (typeof value !== "object") {
    return `<${name}>${escapeXml(value)}</${name}>`;
  }

  const text = name === "genre" && Object.hasOwn(value, "value") ? value.value : null;
  const attributes = [];
  const children = [];
  for (const [key, entry] of Object.entries(value)) {
    if (XML_OMIT_FIELDS.has(key) || (name === "genre" && key === "value")) continue;
    if (entry == null || entry === undefined) continue;
    if (typeof entry === "object") children.push(renderXmlElement(key, entry));
    else attributes.push(`${key}="${escapeXml(entry)}"`);
  }
  const opening = `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  const body = [text == null ? "" : escapeXml(text), ...children].join("");
  return body ? `${opening}${body}</${name}>` : opening.slice(0, -1) + "/>";
}

function renderXml({ status, data = {}, error }) {
  const attributes = Object.entries({ status, version: SUBSONIC_VERSION })
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(" ");
  const body = error
    ? `<error code="${error.code}" message="${escapeXml(error.message)}"/>`
    : Object.entries(data)
        .map(([key, value]) => renderXmlElement(key, value))
        .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="${SUBSONIC_NAMESPACE}" ${attributes}>${body}</subsonic-response>`;
}

function sendResponse(res, format, status = "ok", error = null, data = {}) {
  const payload = {
    "subsonic-response": {
      ...responseAttributes(status),
      ...(error ? { error } : data),
    },
  };
  res.type(format === "json" ? "application/json" : "application/xml");
  return res.send(
    format === "json"
      ? JSON.stringify(payload)
      : renderXml({ status, data, error }),
  );
}

function sendError(res, format, code, message) {
  return sendResponse(res, format, "failed", { code, message });
}

function requestedFormat(req) {
  const format = getParameter(req, "f").toLowerCase() || "xml";
  return format === "xml" || format === "json" ? format : null;
}

function validateRequest(req, format) {
  if (!format) return { format: "xml", error: [0, "Unsupported response format. Use xml or json."] };

  for (const parameter of ["u", "v", "c"]) {
    if (!getParameter(req, parameter)) {
      return { format, error: [10, `Required parameter is missing: ${parameter}`] };
    }
  }

  const password = getParameter(req, "p");
  const token = getParameter(req, "t");
  const salt = getParameter(req, "s");
  if (!password && !(token && salt)) {
    return { format, error: [10, "Required parameter is missing: p or t/s"] };
  }

  const version = parseVersion(getParameter(req, "v"));
  if (!version) {
    return { format, error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."] };
  }
  if (version.major > 1 || (version.major === 1 && version.minor > 16)) {
    return { format, error: [30, "Incompatible Subsonic REST protocol version. Server must upgrade."] };
  }
  if (version.major < 1) {
    return { format, error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."] };
  }

  return { format, password, token, salt };
}

const groupArtists = (artists) => {
  const groups = new Map();
  for (const artist of artists) {
    const name = String(artist.name || "#");
    const key = name.slice(0, 1).toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(artist);
  }
  return [...groups.entries()].map(([name, artist]) => ({ name, artist }));
};

function handleBinaryError(res, message = "Requested media was not found") {
  return res.status(404).set("Content-Type", "text/plain; charset=utf-8").send(message);
}

async function handleSubsonicRequest(req, res) {
  const validation = validateRequest(req, requestedFormat(req));
  if (validation.error) return sendError(res, validation.format, ...validation.error);

  const { format, password, token, salt } = validation;
  const decodedPassword = password ? decodePassword(password) : null;
  const user = password
    ? decodedPassword == null
      ? null
      : resolveUser(getParameter(req, "u"), decodedPassword)
    : resolveSubsonicTokenUser(getParameter(req, "u"), token, salt);
  if (!user) return sendError(res, format, 40, "Wrong username or password");
  req.user = user;

  const method = String(req.params.method || "").replace(/\.view$/i, "").toLowerCase();
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
        playlistRole: Boolean(req.user.permissions?.accessFlow),
        podcastRole: false,
        scrobblingEnabled: false,
        settingsRole: isAdmin,
        shareRole: false,
        streamRole: true,
        uploadRole: false,
        videoConversionRole: false,
      },
    });
  }
  if (method === "getlicense") {
    return sendResponse(res, format, "ok", null, { license: { valid: true } });
  }
  if (method === "getmusicfolders") {
    return sendResponse(res, format, "ok", null, {
      musicFolders: { musicFolder: [{ id: 1, name: APP_NAME }] },
    });
  }
  if (method === "getalbumlist2") {
    return sendResponse(res, format, "ok", null, {
      albumList2: {
        album: getAlbumList({
          fromYear: getParameter(req, "fromYear"),
          genre: getParameter(req, "genre"),
          offset: getParameter(req, "offset"),
          size: getParameter(req, "size"),
          toYear: getParameter(req, "toYear"),
          type: getParameter(req, "type"),
        }),
      },
    });
  }
  if (method === "getgenres") {
    return sendResponse(res, format, "ok", null, { genres: { genre: getGenres() } });
  }
  if (method === "getsongsbygenre") {
    const genre = getParameter(req, "genre").trim();
    if (!genre) return sendError(res, format, 10, "Required parameter is missing: genre");
    return sendResponse(res, format, "ok", null, {
      songsByGenre: {
        song: getSongsByGenre(genre, {
          count: getParameter(req, "count"),
          offset: getParameter(req, "offset"),
        }),
      },
    });
  }
  if (method === "getartists" || method === "getindexes") {
    const indexes = groupArtists(listArtists());
    return sendResponse(res, format, "ok", null, {
      [method === "getartists" ? "artists" : "indexes"]: {
        ignoredArticles: "The El La Los Las Le Les",
        ...(method === "getindexes" ? { lastModified: Date.now() } : {}),
        index: indexes,
      },
    });
  }
  if (method === "getartist") {
    const artist = getArtist(getParameter(req, "id"));
    return artist
      ? sendResponse(res, format, "ok", null, { artist })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getartistinfo") {
    const artistInfo = getArtistInfo(getParameter(req, "id"));
    return artistInfo
      ? sendResponse(res, format, "ok", null, { artistInfo })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getalbum") {
    const album = getAlbum(getParameter(req, "id"));
    return album
      ? sendResponse(res, format, "ok", null, { album })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getsong") {
    const song = getSong(getParameter(req, "id"), user);
    return song
      ? sendResponse(res, format, "ok", null, { song })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "getmusicdirectory") {
    const directory = getMusicDirectory(getParameter(req, "id"));
    return directory
      ? sendResponse(res, format, "ok", null, { directory })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "search3" || method === "search2") {
    const query = getParameter(req, "query");
    return sendResponse(res, format, "ok", null, {
      [method === "search3" ? "searchResult3" : "searchResult2"]: searchLibrary(query, req.query),
    });
  }
  if (method === "getplaylists") {
    return sendResponse(res, format, "ok", null, { playlists: { playlist: getFlowPlaylists(user) } });
  }
  if (method === "getstarred" || method === "getstarred2") {
    return sendResponse(res, format, "ok", null, {
      [method === "getstarred" ? "starred" : "starred2"]: getStarred(user),
    });
  }
  if (method === "star" || method === "unstar") {
    const targets = getParameters(req, ["id", "albumId", "artistId"]);
    const changed = method === "star"
      ? starMany(user, targets)
      : unstarMany(user, targets);
    return changed
      ? sendResponse(res, format)
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "gettopsongs") {
    const artist = String(getParameter(req, "artist") || "").trim();
    if (!artist) return sendError(res, format, 10, "Required parameter is missing: artist");
    return sendResponse(res, format, "ok", null, {
      topSongs: {
        song: getTopSongs(artist, { count: getParameter(req, "count") }),
      },
    });
  }
  if (method === "getplaylist") {
    const playlist = getFlowPlaylist(getParameter(req, "id"), user);
    return playlist
      ? sendResponse(res, format, "ok", null, { playlist })
      : sendError(res, format, 70, "Requested data was not found");
  }
  if (method === "stream" || method === "download") {
    const filePath = resolveStreamPath(getParameter(req, "id"), user);
    if (!filePath) return handleBinaryError(res, "Track file missing");
    const streamed = await streamAudioFile(req, res, filePath);
    return streamed || res.headersSent ? undefined : handleBinaryError(res, "Track file missing");
  }
  if (method === "getcoverart") {
    const playlistArtwork = await resolvePlaylistArtwork(getParameter(req, "id"), user);
    if (playlistArtwork) {
      res.set("Cache-Control", "private, max-age=86400");
      return res.sendFile(playlistArtwork.safePath);
    }
    const artworkUrl = await resolveArtworkUrl(getParameter(req, "id"));
    if (!artworkUrl) return handleBinaryError(res, "Cover art not found");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.redirect(302, artworkUrl);
  }
  return sendError(res, format, 0, `Unsupported request: ${method}`);
}

router.all("/:method", handleSubsonicRequest);
router.use((_req, res) => sendError(res, "xml", 0, "Unsupported request"));

export { groupArtists, renderXmlElement };
export default router;
