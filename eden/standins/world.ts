import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WORLD_RELEASES, readWorldManifest } from "../library/generate.ts";
import { searchKey } from "../metadata/search.ts";

// The stand-in for everything Eden's download services reach on the internet: a
// Newznab indexer, a Torznab indexer, and the web seed their torrents download from.
// The files are the generated releases in the world folder.

const ROOT = process.env.EDEN_WORLD || "/world";
const SELF = process.env.EDEN_WORLD_URL || "http://world:8080";
// Prowlarr redirects a Usenet grab to the indexer's own link, and the one fetching it
// is Aurral on the host, so NZB links carry the address the host reaches this server at.
const HOST_URL = process.env.EDEN_WORLD_HOST_URL || SELF;
const PORT = Number(process.env.PORT || 8080);
const PIECE_LENGTH = 256 * 1024;
const INTERNAL_SEARCH_MS = 8000;
const AUDIO = 3000;
const LOSSLESS = 3040;

const FILES = path.join(ROOT, WORLD_RELEASES);

const releases = new Map(
  readWorldManifest(ROOT).map((release) => [
    release.id,
    {
      ...release,
      key: searchKey(release.name),
      artistKey: searchKey(release.artist),
      albumKey: searchKey(release.album),
      published: new Date(release.date || "2000-01-01"),
      size: release.files.reduce((total, file) => total + file.size, 0),
    },
  ]),
);
type Release = typeof releases extends Map<string, infer Entry> ? Entry : never;

const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character] ?? "",
  );

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Eden"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <music-search available="yes" supportedParams="q,artist,album"/>
  </searching>
  <categories>
    <category id="${AUDIO}" name="Audio"><subcat id="${LOSSLESS}" name="Lossless"/></category>
  </categories>
</caps>`;

function search(params: URLSearchParams) {
  const words = searchKey(params.get("q")).split(" ").filter(Boolean);
  const artist = searchKey(params.get("artist"));
  const album = searchKey(params.get("album"));
  const offset = Number.parseInt(params.get("offset") ?? "0", 10) || 0;
  const limit = Math.min(Number.parseInt(params.get("limit") ?? "100", 10) || 100, 100);
  const found = [...releases.values()].filter(
    (release) =>
      words.every((word) => release.key.includes(word)) &&
      release.artistKey.includes(artist) &&
      release.albumKey.includes(album),
  );
  return { total: found.length, page: found.slice(offset, offset + limit), offset };
}

function feed(protocol: "newznab" | "torznab", params: URLSearchParams, base: string) {
  const { total, page, offset } = search(params);
  const usenet = protocol === "newznab";
  const items = page.map((release) => {
    const url = usenet ? `${base}/nzb/${release.id}.nzb` : `${SELF}/torrent/${release.id}.torrent`;
    const attributes: [string, string | number][] = [
      ["category", AUDIO],
      ["category", LOSSLESS],
      ["size", release.size],
      ["files", release.files.length],
      ...(usenet
        ? ([["grabs", 25]] satisfies [string, number][])
        : ([
            ["seeders", 12],
            ["peers", 14],
            ["infohash", torrentOf(release).infoHash],
          ] satisfies [string, string | number][])),
    ];
    return `<item>
  <title>${escapeXml(release.name)}</title>
  <guid isPermaLink="false">eden-${protocol}-${release.id}</guid>
  <link>${escapeXml(url)}</link>
  <pubDate>${release.published.toUTCString()}</pubDate>
  <category>Audio &gt; Lossless</category>
  <size>${release.size}</size>
  <enclosure url="${escapeXml(url)}" length="${release.size}" type="${usenet ? "application/x-nzb" : "application/x-bittorrent"}"/>
${attributes.map(([name, value]) => `  <${protocol}:attr name="${name}" value="${value}"/>`).join("\n")}
</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
<title>Eden</title>
<description>Eden's stand-in indexer</description>
<newznab:response offset="${offset}" total="${total}"/>
${items.join("\n")}
</channel>
</rss>`;
}

// NZBGet's test news server names an article by the file it serves and the byte range.
function nzb(release: Release) {
  const posted = Math.floor(release.published.getTime() / 1000);
  const files = release.files.map(
    (
      file,
    ) => `<file poster="eden" date="${posted}" subject="&quot;${escapeXml(file.name)}&quot; yEnc (1/1)">
<groups><group>alt.binaries.eden</group></groups>
<segments>
<segment bytes="${file.size}" number="1">${escapeXml(`${release.name}/${file.name}?1=0:${file.size}`)}</segment>
</segments>
</file>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.0//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.0.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
${files.join("\n")}
</nzb>`;
}

type Bencodable = string | number | Buffer | Bencodable[] | { [key: string]: Bencodable };

function bencode(value: Bencodable): Buffer {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  }
  return Buffer.concat([
    Buffer.from("d"),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [bencode(key), bencode(value[key] ?? "")]),
    Buffer.from("e"),
  ]);
}

const torrents = new Map<string, { file: Buffer; infoHash: string }>();

// No tracker and no peers: the torrent names this server as its web seed, so a
// client downloads every piece over HTTP.
function torrentOf(release: Release) {
  const cached = torrents.get(release.id);
  if (cached) return cached;
  const content = Buffer.concat(
    release.files.map((file) => readFileSync(path.join(FILES, release.name, file.name))),
  );
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += PIECE_LENGTH) {
    pieces.push(
      createHash("sha1")
        .update(content.subarray(offset, offset + PIECE_LENGTH))
        .digest(),
    );
  }
  const info = {
    name: release.name,
    "piece length": PIECE_LENGTH,
    pieces: Buffer.concat(pieces),
    files: release.files.map((file) => ({ length: file.size, path: [file.name] })),
  };
  const torrent = {
    file: bencode({ info, "url-list": [`${SELF}/files/`], "created by": "Aurral Eden" }),
    infoHash: createHash("sha1").update(bencode(info)).digest("hex"),
  };
  torrents.set(release.id, torrent);
  return torrent;
}

function sendFile(request: IncomingMessage, response: ServerResponse, relative: string) {
  const file = path.join(FILES, relative);
  if (!file.startsWith(`${FILES}${path.sep}`)) return response.writeHead(403).end();
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return response.writeHead(404).end();
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) return response.writeHead(416, { "content-range": `bytes */${size}` }).end();
  response.writeHead(range ? 206 : 200, {
    "content-type": "application/octet-stream",
    "content-length": end - start + 1,
    "accept-ranges": "bytes",
    ...(range && { "content-range": `bytes ${start}-${end}/${size}` }),
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(file, { start, end }).pipe(response);
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", SELF);
  const send = (type: string, body: string | Buffer) => {
    response.writeHead(200, { "content-type": type });
    response.end(body);
  };
  // A client on Eden's own network, like Lidarr, asks under /internal and gets links
  // it can reach.
  const [, internal, protocol] = /^(\/internal)?\/(newznab|torznab)\/api$/.exec(url.pathname) ?? [];
  if (protocol === "newznab" || protocol === "torznab") {
    const caps = url.searchParams.get("t") === "caps";
    const xml = caps ? CAPS : feed(protocol, url.searchParams, internal ? SELF : HOST_URL);
    // Lidarr searches for a new artist's album while it is still loading the artist,
    // and rejects what it finds if the answer comes back first. A real indexer takes
    // seconds, so this one does too.
    if (internal && !caps) {
      setTimeout(() => send("application/xml; charset=utf-8", xml), INTERNAL_SEARCH_MS);
      return;
    }
    return send("application/xml; charset=utf-8", xml);
  }
  const [, kind, id] = /^\/(nzb|torrent)\/([0-9a-f-]{36})\.\w+$/.exec(url.pathname) ?? [];
  const release = releases.get(id ?? "");
  if (release && kind === "nzb") return send("application/x-nzb", nzb(release));
  if (release && kind === "torrent") {
    return send("application/x-bittorrent", torrentOf(release).file);
  }
  if (url.pathname.startsWith("/files/")) {
    return sendFile(request, response, decodeURIComponent(url.pathname.slice("/files/".length)));
  }
  if (url.pathname === "/health") return send("application/json", `{"releases":${releases.size}}`);
  response.writeHead(404).end();
}).listen(PORT, () => console.log(`Eden world: ${releases.size} releases on :${PORT}`));
