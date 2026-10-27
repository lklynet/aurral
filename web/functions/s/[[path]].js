import {
  getInstance,
  INSTANCE_ID_PATTERN,
  SHARE_TOKEN_PATTERN,
  TUNNEL_URL_PATTERN,
} from "../_shareInstances.js";
import { getHostedShare, loadSharedFiles } from "../_shareManifests.js";

const PAYLOAD_VERSION = 1;
const MAX_NAME_BYTES = 160;
const MAX_PAYLOAD_BYTES = 3 + 3 * 16 + 3 * MAX_NAME_BYTES + 2;
const MAX_PAYLOAD_LENGTH = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3);
const KINDS = {
  1: { kind: "artist", ids: ["artistMbid"], names: ["artistName"] },
  2: { kind: "album", ids: ["albumMbid", "artistMbid"], names: ["title", "artistName"] },
  3: {
    kind: "track",
    ids: ["trackMbid", "albumMbid", "artistMbid"],
    names: ["title", "artistName", "albumTitle"],
  },
};
const OG_TYPES = {
  artist: "website",
  album: "music.album",
  track: "music.song",
  playlist: "music.playlist",
};
const DEEZER_TIMEOUT_MS = 2500;
const PAGE_CACHE_SECONDS = 3600;
const LISTEN_TIMEOUT_MS = 5000;
const TRACK_PATH_PATTERN = /^tracks\/\d+\/\d+$/;

function fromBase64Url(segment) {
  if (!segment || segment.length > MAX_PAYLOAD_LENGTH || !/^[A-Za-z0-9_-]+$/.test(segment))
    return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function readMbid(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeSharePayload(segment) {
  const bytes = fromBase64Url(segment);
  if (!bytes || bytes.length < 3 || bytes[0] !== PAYLOAD_VERSION) return null;
  const shape = KINDS[bytes[1]];
  const idMask = bytes[2];
  if (!shape || idMask >= 1 << shape.ids.length) return null;
  const item = { kind: shape.kind };
  let offset = 3;
  for (const [index, field] of shape.ids.entries()) {
    item[field] = null;
    if (!(idMask & (1 << index))) continue;
    if (bytes.length < offset + 16) return null;
    item[field] = readMbid(bytes.subarray(offset, offset + 16));
    offset += 16;
  }
  const namesStart = offset;
  if (bytes.length <= namesStart) return null;
  let names;
  try {
    names = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(namesStart))
      .split("\0");
  } catch {
    return null;
  }
  if (names.length !== shape.names.length) return null;
  shape.names.forEach((field, index) => {
    item[field] = names[index].trim();
  });
  if (!item[shape.names[0]] || !item.artistName) return null;
  return item;
}

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const normalizeName = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const matchScore = (expected, actual) => {
  const left = normalizeName(expected);
  const right = normalizeName(actual);
  if (!left || !right) return 0;
  if (left === right) return 2;
  return right.startsWith(left) || left.startsWith(right) ? 1 : 0;
};

const releaseScore = (item, title, artistName) =>
  matchScore(item.artistName, artistName) === 2 ? matchScore(item.title, title) : 0;

const DEEZER_SEARCHES = {
  artist: {
    path: "artist",
    query: (item) => item.artistName,
    score: (item, result) => (matchScore(item.artistName, result?.name) === 2 ? 2 : 0),
    pick: (result) => ({
      link: result.link,
      art: result.picture_xl || result.picture_big,
      artMatches: true,
    }),
  },
  album: {
    path: "album",
    query: (item) => `${item.artistName} ${item.title}`,
    score: (item, result) => releaseScore(item, result?.title, result?.artist?.name),
    pick: (result, score) => ({
      link: result.link,
      art: result.cover_xl || result.cover_big,
      artMatches: score === 2,
    }),
  },
  track: {
    path: "track",
    query: (item) => `${item.artistName} track:"${item.title.replace(/"/g, "")}"`,
    score: (item, result) =>
      matchScore(item.artistName, result?.artist?.name) === 2 &&
      [result?.title, result?.title_short].some((title) => matchScore(item.title, title) === 2)
        ? 2
        : 0,
    pick: (result, score, item) => ({
      link: result.link,
      art: result.album?.cover_xl || result.album?.cover_big,
      artMatches: matchScore(item.albumTitle, result.album?.title) === 2,
      previewId: result.preview ? String(result.id) : null,
    }),
  },
};

const httpsUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export async function findOnDeezer(item) {
  const search = DEEZER_SEARCHES[item.kind];
  if (!search) return {};
  const url = `https://api.deezer.com/search/${search.path}?limit=10&q=${encodeURIComponent(search.query(item))}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      cf: { cacheTtl: PAGE_CACHE_SECONDS, cacheEverything: true },
    });
    if (!response.ok) return {};
    const body = await response.json();
    let best = null;
    let bestScore = 0;
    for (const result of Array.isArray(body?.data) ? body.data : []) {
      const score = search.score(item, result);
      if (score > bestScore) {
        best = result;
        bestScore = score;
      }
    }
    if (!best) return {};
    const match = search.pick(best, bestScore, item);
    return {
      link: httpsUrl(match.link),
      art: httpsUrl(match.art),
      artMatches: match.artMatches,
      catalogId:
        item.kind !== "track" && bestScore === 2 && /^\d{1,20}$/.test(String(best.id))
          ? String(best.id)
          : null,
      preview: /^\d{1,20}$/.test(match.previewId) ? `/api/deezer/preview/${match.previewId}` : null,
    };
  } catch {
    return {};
  }
}

function parseListen(segment) {
  const [instanceId, token, extra] = String(segment || "").split(".");
  if (
    extra !== undefined ||
    !INSTANCE_ID_PATTERN.test(instanceId || "") ||
    !SHARE_TOKEN_PATTERN.test(token || "")
  ) {
    return null;
  }
  return { instanceId, token };
}

async function findCatalogPreviews(item, deezer) {
  if (!deezer.catalogId || (item.kind !== "artist" && item.kind !== "album")) return [];
  try {
    const path =
      item.kind === "artist"
        ? `artist/${deezer.catalogId}/top`
        : `album/${deezer.catalogId}/tracks`;
    const response = await fetch(`https://api.deezer.com/${path}?limit=25`, {
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      cf: { cacheTtl: PAGE_CACHE_SECONDS, cacheEverything: true },
    });
    if (!response.ok) return [];
    const body = await response.json();
    return (Array.isArray(body?.data) ? body.data : [])
      .slice(0, 25)
      .filter(
        (track) =>
          track?.preview && /^\d{1,20}$/.test(String(track.id)) && typeof track.title === "string",
      )
      .map((track) => ({
        title: track.title,
        artistName: typeof track.artist?.name === "string" ? track.artist.name : item.artistName,
        preview: `/api/deezer/preview/${track.id}`,
      }));
  } catch {
    return [];
  }
}

const text = (value) => (typeof value === "string" ? value : "");
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : null);

async function loadListen(db, listen) {
  try {
    const instance = await getInstance(db, listen.instanceId);
    const tunnelUrl = instance?.tunnel_url;
    if (!tunnelUrl || !TUNNEL_URL_PATTERN.test(tunnelUrl)) return null;
    const base = `${tunnelUrl}/share/${listen.token}`;
    const response = await fetch(base, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(LISTEN_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const tracks = (Array.isArray(body?.tracks) ? body.tracks : [])
      .filter((track) => TRACK_PATH_PATTERN.test(text(track?.path)))
      .map((track) => ({
        url: `${base}/${track.path}`,
        title: text(track.title) || "Untitled",
        albumTitle: text(track.albumTitle),
        trackNumber: count(track.trackNumber),
        durationMs: count(track.durationMs),
      }));
    if (!tracks.length) return null;
    return {
      base,
      kind: text(body.kind),
      tracks,
      allowDownload: body.allowDownload === true,
      expiresAt: count(body.expiresAt),
    };
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  if (!ms) return "";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg>';
const OPEN_ICON =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3H3v14h14v-5M10 3h7v7M17 3l-9 9"/></svg>';
const DETAILS_ICON =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 3h10v14H5zM8 7h4M8 10h4M8 13h2"/></svg>';

function playerSection(tracks, { kind, download = null } = {}) {
  if (!tracks.length) return "";
  const first = tracks.find((track) => !track.preview) || tracks[0];
  const previewsOnly = tracks.every((track) => track.preview);
  const label = previewsOnly ? "Play previews" : "Play";
  const rows = tracks
    .map(
      (track, index) => `<li class="track-row" ${index >= 5 ? "data-extra-track" : ""}>
    <button type="button" class="track" data-src="${escapeHtml(track.src)}" ${track.preview ? 'data-preview="true"' : ""} aria-current="false">
      <span class="track-number">${index + 1}</span><span class="track-text"><span class="track-title">${escapeHtml(track.title)}</span>
      <span class="track-album">${escapeHtml(kind === "artist" ? track.albumTitle || track.artistName : track.artistName)}</span></span>
      <span class="track-duration">${track.preview ? "Preview" : escapeHtml(formatDuration(track.durationMs))}</span>
    </button>${track.download ? `<a class="track-download" href="${escapeHtml(track.download)}" download aria-label="Download ${escapeHtml(track.title)}">${DOWNLOAD_ICON}</a>` : ""}
  </li>`,
    )
    .join("");
  return `<section class="player" data-player aria-label="${previewsOnly ? "30-second previews" : "Shared tracks"}">
    <div class="share-actions"><button type="button" class="button primary" data-play-all data-label="${label}" aria-pressed="false" hidden>
      <svg class="play-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>
      <svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
      <span data-play-label>${label}</span></button>
      ${download ? `<a class="download-all" href="${escapeHtml(download)}" download>${DOWNLOAD_ICON}${kind === "track" ? "Download" : "Download all"}</a>` : ""}
    </div>
    <audio controls preload="none" src="${escapeHtml(first.src)}" aria-label="Shared music player"></audio>
    <div class="transport" data-transport hidden><input class="seek" data-seek type="range" min="0" max="100" step="0.1" value="0" disabled aria-label="Seek" />
      <div class="times"><span data-elapsed>0:00</span><span data-duration>${previewsOnly ? "0:30" : escapeHtml(formatDuration(first.durationMs)) || "0:00"}</span></div></div>
    <ol class="tracks ${kind === "track" && tracks.length === 1 ? "tracks--single" : ""}">${rows}</ol>
    ${tracks.length > 5 ? `<button type="button" class="text-button" data-show-tracks data-label="View all ${tracks.length} tracks" aria-expanded="false" hidden>View all ${tracks.length} tracks</button>` : ""}
    <p class="note" data-play-status role="status" hidden></p>
  </section>`;
}

function listenSection(listen) {
  return playerSection(
    listen.tracks.map((track) => ({
      ...track,
      src: `${track.url}/stream`,
      preview: false,
      download: listen.allowDownload ? `${track.url}/download` : null,
    })),
    { kind: listen.kind, download: listen.allowDownload ? `${listen.base}/download` : null },
  );
}

function aurralMenu(item, url, listen) {
  const path = (action) =>
    escapeHtml(`/share/import?url=${encodeURIComponent(url)}&action=${action}`);
  return `<details class="aurral" data-aurral hidden><summary>My Aurral<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg></summary>
    <div class="aurral-panel"><div data-aurral-actions>
      ${item.kind !== "playlist" ? `<a class="aurral-action" href="#aurral-url" data-aurral-action data-path="${path("open")}">${OPEN_ICON}Open in my Aurral</a>` : ""}
      <a class="aurral-action" href="#aurral-url" data-aurral-action data-path="${path("details")}">${DETAILS_ICON}Import details only</a>
      ${listen?.allowDownload ? `<a class="aurral-action" href="#aurral-url" data-aurral-action data-path="${path("files")}">${DOWNLOAD_ICON}Import shared files</a>` : `<button class="aurral-action" type="button" disabled aria-describedby="files-unavailable">${DOWNLOAD_ICON}Import shared files</button><p class="aurral-hint" id="files-unavailable">${listen === null ? "Shared files are offline." : "Downloads aren't shared."}</p>`}
      <div class="aurral-server" data-aurral-server hidden><span></span><button type="button" class="text-button" data-change-address>Change</button></div>
    </div>
    <form hidden novalidate><button type="button" class="text-button aurral-back" data-aurral-back>Back</button><label for="aurral-url">Your Aurral address</label>
      <input id="aurral-url" type="url" inputmode="url" autocomplete="url" placeholder="https://music.example.com" aria-describedby="aurral-error" />
      <p class="error" id="aurral-error" role="alert" hidden>Enter your Aurral address, like music.example.com.</p>
      <button type="submit" class="button primary">Continue</button>
    </form></div></details>`;
}

function searchQuery(item) {
  if (item.kind === "artist") return item.artistName;
  return `${item.artistName} ${item.title}`;
}

function listenLinks(item, deezerLink) {
  const query = encodeURIComponent(searchQuery(item));
  return [
    ["Spotify", `https://open.spotify.com/search/${query}`],
    ["Apple Music", `https://music.apple.com/us/search?term=${query}`],
    ["YouTube Music", `https://music.youtube.com/search?q=${query}`],
    ["TIDAL", `https://listen.tidal.com/search?q=${query}`],
    ["Deezer", deezerLink || `https://www.deezer.com/search/${query}`],
  ];
}

function describe(item) {
  if (item.kind === "playlist") return { heading: item.title, kicker: "Playlist", byline: "" };
  if (item.kind === "artist") {
    return { heading: item.artistName, kicker: "Artist", byline: "" };
  }
  if (item.kind === "album") {
    return { heading: item.title, kicker: "Album", byline: item.artistName };
  }
  return {
    heading: item.title,
    kicker: item.albumTitle ? `Track · ${item.albumTitle}` : "Track",
    byline: item.artistName,
  };
}

function securityHeaders(nonce) {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      "img-src 'self' https:",
      "media-src 'self' https:",
      `style-src 'self' 'nonce-${nonce}'`,
      "font-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
}

function page({ type, title, description, image, url, nonce, body, script = false, menu = "" }) {
  const metaImage = image
    ? `<meta property="og:image" content="${escapeHtml(image)}" />
    <meta name="twitter:card" content="summary_large_image" />`
    : `<meta name="twitter:card" content="summary" />`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="#000000" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="${type}" />
    <meta property="og:site_name" content="Aurral" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    ${metaImage}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/share-page.css" />
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" width="27" height="20" />Aurral</a>
      ${menu}
    </header>
    <main>${body}</main>
    <footer>Shared with <a href="/">Aurral</a></footer>
    ${script ? `<script nonce="${nonce}" src="/share-page.js" data-cfasync="false" defer></script>` : ""}
  </body>
</html>`;
}

function notFoundPage(url, nonce) {
  return page({
    type: "website",
    title: "Share link not found | Aurral",
    description: "This Aurral share link is incomplete or broken.",
    image: null,
    url,
    nonce,
    body: `<div class="share">
      <div class="meta">
        <h1>This share link is broken</h1>
        <p class="byline">Part of the link may be missing. Ask the person who sent it to share it again.</p>
      </div>
      <a class="button" href="/">Go to aurral.org</a>
    </div>`,
  });
}

function manifestPlayer(item, listen, segment) {
  return playerSection(
    item.tracks.map((track, index) => {
      const file = listen?.tracks.find((entry) => entry.path === track.path);
      return {
        ...track,
        src: file
          ? `${file.url}/stream`
          : `/api/shares/preview?share=${encodeURIComponent(segment)}&track=${index}`,
        preview: !file,
        download: file && listen.allowDownload ? `${file.url}/download` : null,
      };
    }),
    { kind: item.kind, download: listen?.allowDownload ? `${listen.base}/download` : null },
  );
}

function sharePage(item, deezer, url, nonce, listen, segment, catalogPreviews) {
  const { heading, kicker, byline } = describe(item);
  const coverArt =
    item.kind !== "artist" && item.albumMbid
      ? `https://coverartarchive.org/release-group/${item.albumMbid}/front-500`
      : null;
  const image = (deezer.artMatches && deezer.art) || coverArt || deezer.art;
  const initial = heading.trim().charAt(0).toUpperCase() || "♪";
  const title = byline ? `${heading} by ${byline}` : heading;
  const description =
    item.kind === "playlist"
      ? `Listen to the playlist ${item.title}.`
      : item.kind === "artist"
        ? `Listen to ${item.artistName}.`
        : item.kind === "album"
          ? `Listen to the album ${item.title} by ${item.artistName}.`
          : `Listen to ${item.title} by ${item.artistName}.`;
  const covers =
    item.kind === "playlist"
      ? [...new Set(item.tracks.map((track) => track.albumMbid).filter(Boolean))].slice(0, 4)
      : [];
  const collage = covers.length > 1;
  const art = collage
    ? Array.from(
        { length: 4 },
        (_, index) =>
          `<span><img src="https://coverartarchive.org/release-group/${escapeHtml(covers[index % covers.length])}/front-250" alt="" data-fallback="${escapeHtml(initial)}" /></span>`,
      ).join("")
    : image
      ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.kind === "artist" ? heading : `${heading} cover`)}" data-fallback="${escapeHtml(initial)}" />`
      : `<span aria-hidden="true">${escapeHtml(initial)}</span>`;
  const unavailable =
    listen === null ? `<p class="unavailable" role="status">Shared files are offline.</p>` : "";
  const catalogPlayer = playerSection(
    catalogPreviews.map((track) => ({ ...track, src: track.preview, preview: true })),
    { kind: item.kind },
  );
  const preview = item.tracks?.length
    ? manifestPlayer(item, listen, segment)
    : listen
      ? listenSection(listen)
      : deezer.preview
        ? playerSection(
            [
              {
                title: item.title,
                artistName: item.artistName,
                src: deezer.preview,
                preview: true,
              },
            ],
            { kind: item.kind },
          )
        : catalogPlayer;
  const links = listenLinks(item, deezer.link)
    .map(
      ([name, href]) =>
        `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a></li>`,
    )
    .join("");
  return page({
    type: OG_TYPES[item.kind],
    script: true,
    menu: aurralMenu(item, url, listen),
    title: `${title} | Aurral`,
    description,
    image,
    url,
    nonce,
    body: `<article class="share">
      <div class="share-head"><div class="art${item.kind === "artist" ? " art--round" : collage ? " art--collage" : ""}">${art}</div>
      <div class="meta">
        <h1>${escapeHtml(heading)}</h1>
        ${byline ? `<p class="byline">${escapeHtml(byline)}</p>` : ""}
        <p class="kicker">${escapeHtml(kicker)}${item.kind !== "track" && item.tracks?.length ? `, ${item.tracks.length} tracks` : ""}</p>
      </div></div>
      ${unavailable}
      ${preview}
      <section class="listen-section" aria-labelledby="listen-title">
        <p class="section-title" id="listen-title">Listen on</p>
        <ul class="listen">${links}</ul>
      </section>
    </article>`,
  });
}

export async function onRequest({ request, params, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const segments = Array.isArray(params?.path) ? params.path : [params?.path].filter(Boolean);
  if (!segments.length) return Response.redirect(new URL("/", request.url).toString(), 302);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const [payload, listenSegment] = segments.length === 1 ? segments[0].split("~") : [];
  const hosted =
    segments.length === 1 && !listenSegment ? await getHostedShare(env?.SHARE_DB, payload) : null;
  const item = hosted?.manifest || (payload ? decodeSharePayload(payload) : null);
  const listenRequest = listenSegment === undefined ? undefined : parseListen(listenSegment);
  if (!item) {
    return new Response(notFoundPage(request.url, nonce), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(nonce) },
    });
  }
  const [deezer, listen] = await Promise.all([
    findOnDeezer(item),
    hosted
      ? hosted.shareFiles
        ? loadSharedFiles(env?.SHARE_DB, hosted.instanceId, hosted.token)
        : undefined
      : listenRequest === undefined
        ? undefined
        : listenRequest && loadListen(env?.SHARE_DB, listenRequest),
  ]);
  const catalogPreviews =
    !item.tracks?.length && !listen ? await findCatalogPreviews(item, deezer) : [];
  return new Response(
    sharePage(item, deezer, request.url, nonce, listen, segments[0], catalogPreviews),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control":
          !hosted && listen === undefined
            ? `public, max-age=${PAGE_CACHE_SECONDS}`
            : "private, no-store",
        ...securityHeaders(nonce),
      },
    },
  );
}
