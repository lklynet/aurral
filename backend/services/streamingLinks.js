import { decode } from "html-entities";
import createCache from "./apiClients/simpleCache.js";
import { resolveArtistAndAlbumMbids } from "./apiClients/index.js";
import { getAlbumTracksByAlbumMbid } from "./providers/brainzmashProvider.js";
import { matchTrackByTitle } from "./downloadJobs/trackSearchContext.js";

const REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_CACHE_TTL_SECONDS = 24 * 60 * 60;
const DEEZER_NO_DATA_CODE = 800;
const DEEZER_QUOTA_CODE = 4;

const lookupCache = createCache(LOOKUP_CACHE_TTL_SECONDS, 2000);

const SERVICE_NAMES = {
  spotify: "Spotify",
  appleMusic: "Apple Music",
  youtubeMusic: "YouTube Music",
  tidal: "TIDAL",
  deezer: "Deezer",
  songlink: "song.link",
};

const LINK_HOSTS = new Map([
  ["open.spotify.com", "spotify"],
  ["music.apple.com", "appleMusic"],
  ["music.youtube.com", "youtubeMusic"],
  ["tidal.com", "tidal"],
  ["www.tidal.com", "tidal"],
  ["listen.tidal.com", "tidal"],
  ["deezer.com", "deezer"],
  ["www.deezer.com", "deezer"],
  ["song.link", "songlink"],
  ["album.link", "songlink"],
]);

const KINDS = { album: "album", track: "track", song: "track", artist: "artist" };

const linkError = (message, statusCode, code) =>
  Object.assign(new Error(message), { statusCode, code });

const unsupportedLink = () =>
  linkError(
    "Enter a Spotify, Apple Music, YouTube Music, TIDAL, Deezer, or song.link album, track, or artist link",
    400,
    "LINK_UNSUPPORTED",
  );

const notFound = (source) =>
  linkError(`${SERVICE_NAMES[source]} could not find this link`, 404, "LINK_NOT_FOUND");

const unavailable = (source, detail = "could not be reached") =>
  linkError(`${SERVICE_NAMES[source]} ${detail}`, 502, "LINK_SERVICE_UNAVAILABLE");

const parsers = {
  spotify(url) {
    const match = url.pathname.match(
      /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(album|track|artist)\/([A-Za-z0-9]{22})\/?$/i,
    );
    return match && { kind: KINDS[match[1].toLowerCase()], id: match[2] };
  },
  appleMusic(url) {
    const match = url.pathname.match(/^\/(?:([a-z]{2})\/)?(album|song|artist)\/(?:[^/]+\/)?(\d+)\/?$/i);
    if (!match) return null;
    const country = (match[1] || "us").toLowerCase();
    const trackId = url.searchParams.get("i");
    if (match[2].toLowerCase() === "album" && trackId) {
      return /^\d+$/.test(trackId) ? { kind: "track", id: trackId, country } : null;
    }
    return { kind: KINDS[match[2].toLowerCase()], id: match[3], country };
  },
  youtubeMusic(url) {
    const path = url.pathname.replace(/\/$/, "");
    const videoId = url.searchParams.get("v");
    if (path === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(videoId || "")) {
      return { kind: "track", id: videoId, path: `/watch?v=${videoId}` };
    }
    const listId = url.searchParams.get("list");
    if (path === "/playlist" && /^OLAK5uy_[A-Za-z0-9_-]{1,100}$/.test(listId || "")) {
      return { kind: "album", id: listId, path: `/playlist?list=${listId}` };
    }
    const channel = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})$/);
    return channel && { kind: "artist", id: channel[1], path: `/channel/${channel[1]}` };
  },
  tidal(url) {
    const match = url.pathname.match(/^\/(?:browse\/)?(album|track|artist)\/(\d+)(?:\/u)?\/?$/i);
    return match && { kind: KINDS[match[1].toLowerCase()], id: match[2] };
  },
  deezer(url) {
    const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(album|track|artist)\/(\d+)\/?$/i);
    return match && { kind: KINDS[match[1].toLowerCase()], id: match[2] };
  },
  songlink(url) {
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{1,64})(?:\/([A-Za-z0-9_-]{1,64}))?\/?$/);
    if (!match) return null;
    const path = `/${match.slice(1).filter(Boolean).join("/")}`;
    return { kind: null, id: `${url.hostname}${path}`, pageUrl: `https://${url.hostname}${path}` };
  },
};

function parseStreamingLink(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw unsupportedLink();
  }
  const source = LINK_HOSTS.get(url.hostname.toLowerCase());
  if (
    !source ||
    !["https:", "http:"].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw unsupportedLink();
  }
  const parsed = parsers[source](url);
  if (!parsed) throw unsupportedLink();
  return { source, ...parsed, cacheKey: [source, parsed.kind || "page", parsed.id, parsed.country].filter(Boolean).join(":") };
}

async function fetchUpstream(source, url, { accept = "application/json", headers = {} } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: accept, ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailable(source);
  }
  if (response.status === 404) throw notFound(source);
  if (response.status === 429) {
    throw linkError(
      `${SERVICE_NAMES[source]} is rate limiting requests; try again later`,
      429,
      "LINK_SERVICE_RATE_LIMITED",
    );
  }
  if (!response.ok) throw unavailable(source, `request failed (${response.status})`);
  try {
    return await response.text();
  } catch {
    throw unavailable(source);
  }
}

async function fetchJson(source, url) {
  const text = await fetchUpstream(source, url);
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable(source, "returned an unreadable response");
  }
}

const fetchHtml = (source, url) =>
  fetchUpstream(source, url, { accept: "text/html", headers: { "Accept-Language": "en" } });

const clean = (value) => {
  const text = decode(String(value ?? "")).trim();
  return text || null;
};

function readMetaTags(html) {
  const tags = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(([, name, value]) => [name.toLowerCase(), value]),
    );
    const key = attributes.property || attributes.name;
    if (key && attributes.content != null && !(key in tags)) tags[key] = clean(attributes.content);
  }
  return tags;
}

function readJsonLd(html) {
  const items = [];
  for (const [, body] of html.matchAll(
    /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      items.push(...[JSON.parse(body)].flat());
    } catch {
      continue;
    }
  }
  return items;
}

function readNextData(html) {
  const match = html.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function lookupDeezer({ kind, id }) {
  const body = await fetchJson("deezer", `https://api.deezer.com/${kind}/${id}`);
  if (body?.error) {
    if (body.error.code === DEEZER_NO_DATA_CODE) throw notFound("deezer");
    if (body.error.code === DEEZER_QUOTA_CODE) {
      throw linkError("Deezer is rate limiting requests; try again later", 429, "LINK_SERVICE_RATE_LIMITED");
    }
    throw unavailable("deezer", "returned an error");
  }
  if (kind === "artist") return { kind, artistName: clean(body?.name) };
  if (kind === "album") {
    return { kind, artistName: clean(body?.artist?.name), albumTitle: clean(body?.title), deezerAlbumId: body?.id };
  }
  return {
    kind,
    artistName: clean(body?.artist?.name),
    trackTitle: clean(body?.title),
    albumTitle: clean(body?.album?.title),
    deezerAlbumId: body?.album?.id,
  };
}

const APPLE_WRAPPERS = { artist: "artist", album: "collection", track: "track" };

async function lookupAppleMusic({ kind, id, country }) {
  const url = new URL("https://itunes.apple.com/lookup");
  url.searchParams.set("id", id);
  url.searchParams.set("country", country);
  const body = await fetchJson("appleMusic", url);
  const item = (Array.isArray(body?.results) ? body.results : [])
    .find((entry) => entry?.wrapperType === APPLE_WRAPPERS[kind]);
  if (!item) throw notFound("appleMusic");
  const albumTitle = clean(String(item.collectionName || "").replace(/ - (?:Single|EP)$/, ""));
  if (kind === "artist") return { kind, artistName: clean(item.artistName) };
  if (kind === "album") return { kind, artistName: clean(item.artistName), albumTitle };
  return { kind, artistName: clean(item.artistName), trackTitle: clean(item.trackName), albumTitle };
}

async function lookupSonglinkPage(source, pageUrl) {
  const data = readNextData(await fetchHtml(source, pageUrl));
  const pageData = data?.props?.pageProps?.pageData;
  const entity = pageData?.entityData;
  const kind = KINDS[entity?.type];
  if (!kind || kind === "artist") {
    if (data?.props?.pageProps?.error || (data && !entity?.type)) throw notFound(source);
    throw unavailable(source, "returned an unreadable response");
  }
  const result = {
    kind,
    artistName: clean(entity.artistName),
    ...(kind === "album" ? { albumTitle: clean(entity.title) } : { trackTitle: clean(entity.title) }),
  };
  const deezerUrl = (Array.isArray(pageData.sections) ? pageData.sections : [])
    .flatMap((section) => (Array.isArray(section?.links) ? section.links : []))
    .find((link) => link?.platform === "deezer" && link.url)?.url;
  let deezer = null;
  try {
    deezer = deezerUrl ? parseStreamingLink(deezerUrl) : null;
  } catch {
    deezer = null;
  }
  if (deezer?.source !== "deezer" || deezer.kind !== kind) return result;
  if (kind === "album") return { ...result, deezerAlbumId: deezer.id };
  const track = await lookupDeezer(deezer).catch(() => null);
  return track?.albumTitle
    ? { ...result, albumTitle: track.albumTitle, deezerAlbumId: track.deezerAlbumId }
    : result;
}

async function lookupSpotify({ kind, id }) {
  if (kind !== "artist") {
    return lookupSonglinkPage("spotify", `https://${kind === "album" ? "album" : "song"}.link/s/${id}`);
  }
  const url = new URL("https://open.spotify.com/oembed");
  url.searchParams.set("url", `https://open.spotify.com/artist/${id}`);
  const body = await fetchJson("spotify", url);
  return { kind, artistName: clean(body?.title) };
}

async function lookupTidal({ kind, id }) {
  const pageUrl = `https://tidal.com/${kind}/${id}`;
  const item = readJsonLd(await fetchHtml("tidal", pageUrl)).find((entry) => entry?.["@id"] === pageUrl);
  if (!item) throw notFound("tidal");
  const artistName = kind === "artist" ? clean(item.name) : clean(item.byArtist?.[0]?.name);
  if (kind === "artist") return { kind, artistName };
  if (kind === "album") return { kind, artistName, albumTitle: clean(item.name) };
  return { kind, artistName, trackTitle: clean(item.name), albumTitle: clean(item.inAlbum?.name) };
}

async function lookupYoutubeMusic({ kind, path }) {
  const tags = readMetaTags(await fetchHtml("youtubeMusic", `https://music.youtube.com${path}`));
  const title = tags["og:title"];
  if (!title) throw notFound("youtubeMusic");
  const description = tags["og:description"] || "";
  if (kind === "artist") return { kind, artistName: title };
  if (kind === "album") return { kind, artistName: clean(description.split(" • ")[1]), albumTitle: title };
  return { kind, artistName: clean(description), trackTitle: title };
}

const lookups = {
  spotify: lookupSpotify,
  appleMusic: lookupAppleMusic,
  youtubeMusic: lookupYoutubeMusic,
  tidal: lookupTidal,
  deezer: lookupDeezer,
  songlink: (link) => lookupSonglinkPage("songlink", link.pageUrl),
};

async function lookupLink(link) {
  const cached = lookupCache.get(link.cacheKey);
  if (cached) return cached;
  const result = await lookups[link.source](link);
  if (
    !result.artistName ||
    (result.kind === "track" && !result.trackTitle) ||
    (result.kind === "album" && !result.albumTitle)
  ) {
    throw unavailable(link.source, "returned an unreadable response");
  }
  lookupCache.set(link.cacheKey, result);
  return result;
}

async function matchTrackMbid(albumMbid, trackTitle) {
  if (!albumMbid || !trackTitle) return null;
  const tracks = await getAlbumTracksByAlbumMbid(albumMbid).catch(() => []);
  return matchTrackByTitle(tracks, trackTitle)?.recordingId || null;
}

export async function resolveStreamingLink(value) {
  const link = parseStreamingLink(value);
  const { kind, artistName, albumTitle, trackTitle, deezerAlbumId } = await lookupLink(link);
  const { artistMbid, albumMbid } = await resolveArtistAndAlbumMbids({
    artistName,
    albumName: kind === "artist" ? "" : albumTitle,
    deezerAlbumId,
  });
  return {
    kind,
    artist: { name: artistName, mbid: artistMbid },
    album: kind !== "artist" && albumTitle ? { title: albumTitle, mbid: albumMbid } : null,
    track: kind === "track"
      ? { title: trackTitle, mbid: await matchTrackMbid(albumMbid, trackTitle) }
      : null,
    source: link.source,
  };
}
