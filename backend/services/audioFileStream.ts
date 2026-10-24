import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";

type ByteRange = { start: number; end: number };

const MISSING_FILE_CODES = new Set<string | number | undefined>([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
]);

const AUDIO_CONTENT_TYPES = {
  aac: "audio/aac",
  aiff: "audio/x-aiff",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
};

const knownContentType = (format: string) =>
  isOwnKey(AUDIO_CONTENT_TYPES, format) ? AUDIO_CONTENT_TYPES[format] : undefined;

export function audioContentType(format: string) {
  const normalized = String(format).toLowerCase();
  return knownContentType(normalized) || `audio/${normalized}`;
}

function requestedRange(header: string | undefined, size: number) {
  if (!header || !/^ *bytes=/.test(header)) return undefined;
  const ranges = header
    .slice(header.indexOf("=") + 1)
    .split(",")
    .flatMap((spec): ByteRange[] => {
      const [first = "", last = ""] = spec.split("-");
      const start = Number.parseInt(first, 10);
      const end = Number.parseInt(last, 10);
      const range = Number.isNaN(start)
        ? { start: size - end, end: size - 1 }
        : { start, end: Math.min(Number.isNaN(end) ? size - 1 : end, size - 1) };
      return Number.isNaN(range.start) ||
        Number.isNaN(range.end) ||
        range.start > range.end ||
        range.start < 0
        ? []
        : [range];
    })
    .toSorted((a, b) => a.start - b.start);
  if (ranges.length === 0) return "unsatisfiable";
  return ranges.reduce<ByteRange | undefined>(
    (combined, range) =>
      combined && range.start <= combined.end + 1
        ? { start: combined.start, end: Math.max(combined.end, range.end) }
        : undefined,
    ranges[0],
  );
}

const etagMatches = (tags: string, etag: string) =>
  tags
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => tag === etag || tag === `W/${etag}` || `W/${tag}` === etag);

function isFresh(headers: IncomingHttpHeaders, etag: string, lastModified: string) {
  const noneMatch = headers["if-none-match"];
  const modifiedSince = headers["if-modified-since"];
  if (/(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(headers["cache-control"] ?? "")) return false;
  if (noneMatch) return noneMatch === "*" || etagMatches(noneMatch, etag);
  return modifiedSince != null && Date.parse(lastModified) <= Date.parse(modifiedSince);
}

function rangeIsFresh(headers: IncomingHttpHeaders, etag: string, lastModified: string) {
  const ifRange = headers["if-range"];
  if (typeof ifRange !== "string" || !ifRange) return true;
  if (ifRange.includes('"')) return ifRange.includes(etag);
  return Date.parse(lastModified) <= Date.parse(ifRange);
}

const missingAsNull = (error: unknown) => {
  if (MISSING_FILE_CODES.has(asAppError(error)?.code)) return null;
  throw error;
};

export async function sendAudioFile(req: IncomingMessage, res: ServerResponse, filePath: string) {
  const stats = await stat(filePath).catch(missingAsNull);
  if (!stats?.isFile()) return false;
  const { size } = stats;
  const etag = `W/"${size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
  const lastModified = stats.mtime.toUTCString();
  const headers: Record<string, string | number> = {
    "Accept-Ranges": "bytes",
    "Last-Modified": lastModified,
    ETag: etag,
  };
  if (!res.hasHeader("Cache-Control")) headers["Cache-Control"] = "public, max-age=0";
  if (isFresh(req.headers, etag, lastModified)) {
    res.writeHead(304, headers).end();
    return true;
  }
  headers["Content-Type"] =
    knownContentType(path.extname(filePath).slice(1).toLowerCase()) ?? "application/octet-stream";
  const range = rangeIsFresh(req.headers, etag, lastModified)
    ? requestedRange(req.headers.range, size)
    : undefined;
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
    res.end();
    return true;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  headers["Content-Length"] = Math.max(0, end - start + 1);
  const status = range ? 206 : 200;
  if (req.method === "HEAD") {
    res.writeHead(status, headers).end();
    return true;
  }
  const file = createReadStream(filePath, { start, end: Math.max(start, end) });
  if (!(await once(file, "open").catch(missingAsNull))) return false;
  res.writeHead(status, headers);
  pipeline(file, res).catch(() => {});
  return true;
}
