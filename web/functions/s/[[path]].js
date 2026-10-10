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
const OG_TYPES = { artist: "website", album: "music.album", track: "music.song" };
const DEEZER_TIMEOUT_MS = 2500;
const PAGE_CACHE_SECONDS = 3600;

function fromBase64Url(segment) {
  if (!segment || segment.length > MAX_PAYLOAD_LENGTH || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
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

function decodeSharePayload(segment) {
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
    names = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(namesStart)).split("\0");
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
    pick: (result) => ({ link: result.link, art: result.picture_xl || result.picture_big, artMatches: true }),
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
      preview: result.preview,
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

async function findOnDeezer(item) {
  const search = DEEZER_SEARCHES[item.kind];
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
      preview: httpsUrl(match.preview),
    };
  } catch {
    return {};
  }
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

function aurralPath(item) {
  if (item.kind === "artist" && item.artistMbid) return `/artist/${item.artistMbid}`;
  if (item.kind !== "artist" && item.artistMbid && item.albumMbid) {
    return `/artist/${item.artistMbid}/release/${item.albumMbid}`;
  }
  return `/search?q=${encodeURIComponent(searchQuery(item))}`;
}

function describe(item) {
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

const STYLES = `
:root {
  color-scheme: dark;
  --font-sans: ui-sans-serif, system-ui, -apple-system, blinkmacsystemfont, "Segoe UI", sans-serif;
  --chrome: #050505;
  --surface: #111111;
  --text: #f5f5f5;
  --text-muted: rgb(255 255 255 / 58%);
  --text-subtle: rgb(255 255 255 / 46%);
  --border: rgb(255 255 255 / 8%);
  --border-strong: rgb(255 255 255 / 14%);
  --hover: rgb(255 255 255 / 9%);
  --ring: rgb(255 255 255 / 46%);
  --radius: 10px;
  --radius-sm: 6px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  background: var(--chrome);
  color: var(--text);
  font: 400 16px / 1.5 var(--font-sans);
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
}
h1, p { margin: 0; }
a { color: inherit; text-decoration: none; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius-sm); }
.top { padding: 20px 24px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; }
.brand img { height: 20px; width: auto; }
main { flex: 1; display: flex; justify-content: center; padding: 16px 24px 48px; }
.share { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 24px; }
.art {
  aspect-ratio: 1;
  width: 100%;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-subtle);
  font-size: 96px;
  font-weight: 700;
}
.art--round { border-radius: 9999px; }
.art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.meta { display: flex; flex-direction: column; gap: 4px; }
.kicker { color: var(--text-muted); font-size: 13px; font-weight: 600; }
h1 { font-size: 28px; font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
.byline { color: var(--text-muted); font-size: 16px; }
audio { width: 100%; }
.preview-label { color: var(--text-subtle); font-size: 13px; margin-bottom: 6px; }
.section-title { color: var(--text-muted); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.listen { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.button {
  align-items: center;
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  font: 500 15px / 1 var(--font-sans);
  gap: 8px;
  height: 44px;
  justify-content: center;
  padding-inline: 16px;
  width: 100%;
  transition: background-color 150ms ease, border-color 150ms ease;
}
.button.primary { background: var(--text); border-color: var(--text); color: var(--chrome); }
.button:active { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) {
  .button:hover { background: var(--hover); border-color: rgb(255 255 255 / 22%); }
  .button.primary:hover { background: #ffffff; border-color: #ffffff; }
}
.aurral { border-top: 1px solid var(--border); padding-top: 24px; display: flex; flex-direction: column; gap: 12px; }
.aurral p { color: var(--text-muted); font-size: 14px; }
.aurral form { display: flex; flex-direction: column; gap: 8px; }
.aurral label { font-size: 13px; font-weight: 600; color: var(--text-muted); }
.aurral input {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: 400 15px / 1 var(--font-sans);
  height: 44px;
  padding-inline: 12px;
  width: 100%;
}
.aurral .error { color: #f87171; font-size: 13px; }
.text-button {
  background: none;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
  font: 500 13px / 1 var(--font-sans);
  padding: 4px 0;
  align-self: flex-start;
}
footer { color: var(--text-subtle); font-size: 13px; padding: 24px; text-align: center; }
footer a { color: var(--text-muted); text-decoration: underline; text-underline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const SCRIPT = `
(() => {
  const KEY = "aurral:instance-url";
  const root = document.querySelector("[data-aurral]");
  const path = root.dataset.path;
  const open = root.querySelector("[data-open]");
  const change = root.querySelector("[data-change]");
  const form = root.querySelector("form");
  const input = form.querySelector("input");
  const error = form.querySelector(".error");
  const normalize = (value) => {
    let text = String(value || "").trim();
    if (!text) return null;
    if (!/^https?:\\/\\//i.test(text)) text = "http://" + text;
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin + url.pathname.replace(/\\/+$/, "");
    } catch {
      return null;
    }
  };
  const read = () => {
    try { return normalize(localStorage.getItem(KEY)); } catch { return null; }
  };
  const render = () => {
    const saved = read();
    open.hidden = !saved;
    change.hidden = !saved;
    form.hidden = Boolean(saved);
    if (saved) open.href = saved + path;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = normalize(input.value);
    if (!url) {
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    try { localStorage.setItem(KEY, url); } catch {}
    window.location.href = url + path;
  });
  change.addEventListener("click", () => {
    open.hidden = true;
    change.hidden = true;
    form.hidden = false;
    input.value = read() || "";
    input.focus();
  });
  document.querySelectorAll("img[data-fallback]").forEach((img) => {
    img.addEventListener("error", () => {
      const holder = img.parentElement;
      holder.textContent = img.dataset.fallback;
    });
  });
  render();
})();
`;

function securityHeaders(nonce) {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      "img-src https:",
      "media-src https:",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
}

function page({ type, title, description, image, url, nonce, body, script = "" }) {
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
    <meta name="theme-color" content="#050505" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="${type}" />
    <meta property="og:site_name" content="Aurral" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    ${metaImage}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style nonce="${nonce}">${STYLES}</style>
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" width="27" height="20" />Aurral</a>
    </header>
    <main>${body}</main>
    <footer>Shared from <a href="/">Aurral</a>, self-hosted music discovery.</footer>
    ${script ? `<script nonce="${nonce}" data-cfasync="false">${script}</script>` : ""}
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

function sharePage(item, deezer, url, nonce) {
  const { heading, kicker, byline } = describe(item);
  const coverArt =
    item.kind !== "artist" && item.albumMbid
      ? `https://coverartarchive.org/release-group/${item.albumMbid}/front-500`
      : null;
  const image = (deezer.artMatches && deezer.art) || coverArt || deezer.art;
  const initial = heading.trim().charAt(0).toUpperCase() || "♪";
  const title = byline ? `${heading} by ${byline}` : heading;
  const description =
    item.kind === "artist"
      ? `Listen to ${item.artistName}.`
      : item.kind === "album"
        ? `Listen to the album ${item.title} by ${item.artistName}.`
        : `Listen to ${item.title} by ${item.artistName}.`;
  const art = image
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.kind === "artist" ? heading : `${heading} cover`)}" data-fallback="${escapeHtml(initial)}" />`
    : `<span aria-hidden="true">${escapeHtml(initial)}</span>`;
  const preview = deezer.preview
    ? `<div>
        <p class="preview-label" id="preview-label">30-second preview</p>
        <audio controls preload="none" src="${escapeHtml(deezer.preview)}" aria-labelledby="preview-label"></audio>
      </div>`
    : "";
  const links = listenLinks(item, deezer.link)
    .map(
      ([name, href]) =>
        `<li><a class="button" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a></li>`,
    )
    .join("");
  return page({
    type: OG_TYPES[item.kind],
    script: SCRIPT,
    title: `${title} | Aurral`,
    description,
    image,
    url,
    nonce,
    body: `<article class="share">
      <div class="art${item.kind === "artist" ? " art--round" : ""}">${art}</div>
      <div class="meta">
        <p class="kicker">${escapeHtml(kicker)}</p>
        <h1>${escapeHtml(heading)}</h1>
        ${byline ? `<p class="byline">${escapeHtml(byline)}</p>` : ""}
      </div>
      ${preview}
      <section aria-labelledby="listen-title">
        <p class="section-title" id="listen-title">Listen on</p>
        <ul class="listen">${links}</ul>
      </section>
      <section class="aurral" aria-labelledby="aurral-title" data-aurral data-path="${escapeHtml(aurralPath(item))}">
        <p class="section-title" id="aurral-title">Have Aurral?</p>
        <a class="button primary" data-open hidden>Open in my Aurral</a>
        <button type="button" class="text-button" data-change hidden>Change Aurral address</button>
        <form novalidate>
          <label for="aurral-url">Your Aurral address</label>
          <input id="aurral-url" type="url" inputmode="url" autocomplete="url" placeholder="https://music.example.com" aria-describedby="aurral-error aurral-help" />
          <p class="error" id="aurral-error" role="alert" hidden>Enter your Aurral address, like music.example.com.</p>
          <p id="aurral-help">Saved in this browser only, so next time it opens straight away.</p>
          <button type="submit" class="button">Open in my Aurral</button>
        </form>
      </section>
    </article>`,
  });
}

export async function onRequest({ request, params }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const segments = Array.isArray(params?.path) ? params.path : [params?.path].filter(Boolean);
  if (!segments.length) return Response.redirect(new URL("/", request.url).toString(), 302);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const item = segments.length === 1 ? decodeSharePayload(segments[0]) : null;
  if (!item) {
    return new Response(notFoundPage(request.url, nonce), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(nonce) },
    });
  }
  const deezer = await findOnDeezer(item);
  return new Response(sharePage(item, deezer, request.url, nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${PAGE_CACHE_SECONDS}`,
      ...securityHeaders(nonce),
    },
  });
}
