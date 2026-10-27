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

const PLAY_ICON = `<svg class="play-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>`;
const PAUSE_ICON = `<svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>`;
const SHUFFLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>`;

function playerSection(tracks, { kind, download = null } = {}) {
  if (!tracks.length) return "";
  const first = tracks.find((track) => !track.preview) || tracks[0];
  const previewsOnly = tracks.every((track) => track.preview);
  const single = tracks.length === 1;
  const label = previewsOnly ? "Play previews" : single ? "Play" : "Play all";
  const rows = tracks
    .map(
      (track, index) => `<li class="track-row" ${index >= 5 ? "data-extra-track" : ""}>
    <button type="button" class="track" data-src="${escapeHtml(track.src)}" data-title="${escapeHtml(track.title)}" ${track.preview ? 'data-preview="true"' : ""} aria-current="false" aria-pressed="false" aria-label="Play ${escapeHtml(track.title)}">
      <span class="track-play">${PLAY_ICON}${PAUSE_ICON}</span><span class="track-text"><span class="track-title">${escapeHtml(track.title)}</span>
      <span class="track-album">${escapeHtml(kind === "artist" ? track.albumTitle || track.artistName : track.artistName)}</span></span>
      <span class="track-duration">${track.preview ? "Preview" : escapeHtml(formatDuration(track.durationMs))}</span>
    </button>${track.download ? `<a class="track-download" href="${escapeHtml(track.download)}" download aria-label="Download ${escapeHtml(track.title)}">${DOWNLOAD_ICON}</a>` : ""}
  </li>`,
    )
    .join("");
  return `<section class="player" data-player aria-label="${previewsOnly ? "30-second previews" : "Shared tracks"}">
    <div class="share-actions"><button type="button" class="action" data-play-all hidden>${PLAY_ICON}${label}</button>
      ${single ? "" : `<button type="button" class="action" data-shuffle hidden>${SHUFFLE_ICON}Shuffle</button>`}
      ${download ? `<a class="action" href="${escapeHtml(download)}" download>${DOWNLOAD_ICON}${kind === "track" ? "Download" : "Download all"}</a>` : ""}
    </div>
    <audio controls preload="none" src="${escapeHtml(first.src)}" aria-label="Shared music player"></audio>
    <ol class="tracks ${kind === "track" && single ? "tracks--single" : ""}">${rows}</ol>
    ${tracks.length > 5 ? `<button type="button" class="text-button" data-show-tracks data-label="View all ${tracks.length} tracks" aria-expanded="false" hidden>View all ${tracks.length} tracks</button>` : ""}
    <p class="note" data-play-status role="status" hidden></p>
    <div class="now" data-now hidden>
      <div class="now-row"><span class="now-title" data-now-title></span>
        ${single ? "" : `<button type="button" class="now-button" data-previous aria-label="Previous"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zm3 7 10-7v14z"/></svg></button>`}
        <button type="button" class="now-button" data-toggle aria-pressed="false" aria-label="Play">${PLAY_ICON}${PAUSE_ICON}</button>
        ${single ? "" : `<button type="button" class="now-button" data-next aria-label="Next"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM5 5l10 7-10 7z"/></svg></button>`}
      </div>
      <input class="seek" data-seek type="range" min="0" max="100" step="0.1" value="0" disabled aria-label="Seek" />
      <div class="times"><span data-elapsed>0:00</span><span data-duration>0:00</span></div>
    </div>
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

const SERVICE_ICONS = {
  "Apple Music":
    '<path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z" />',
  TIDAL:
    '<path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996 4.004 12l4.004-4.004L12.012 12l-4.004 4.004 4.004 4.004 4.004-4.004L12.012 12l4.004-4.004-4.004-4.004zM16.042 7.996l3.979-3.979L24 7.996l-3.979 3.979z" />',
  Spotify:
    '<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />',
  "YouTube Music":
    '<path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z" />',
  Deezer:
    '<path d="M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z" />',
};

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
  const covers =
    item.kind === "playlist"
      ? [...new Set(item.tracks.map((track) => track.albumMbid).filter(Boolean))].slice(0, 4)
      : [];
  const artMbid = item.albumMbid || covers[0];
  const coverArt =
    item.kind !== "artist" && artMbid
      ? `https://coverartarchive.org/release-group/${artMbid}/front-500`
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
        `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${SERVICE_ICONS[name]}</svg>${escapeHtml(name)}</a></li>`,
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
