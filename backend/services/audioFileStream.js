import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const AUDIO_CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

function parseRangeHeader(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
  if (!match || size <= 0) return null;

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return null;

  let start = hasStart ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  let end = hasStart && hasEnd ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (hasStart && !hasEnd) end = size - 1;
  if (!hasStart && Number(match[2]) <= 0) return null;
  if (end >= size) end = size - 1;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

export async function streamAudioFile(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  res.setHeader(
    "Content-Type",
    AUDIO_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
  );
  res.setHeader("Accept-Ranges", "bytes");

  if (!req.headers.range) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  const range = parseRangeHeader(req.headers.range, stat.size);
  if (!range) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    return false;
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  res.setHeader("Content-Length", range.end - range.start + 1);
  fs.createReadStream(filePath, range).pipe(res);
  return true;
}

export { parseRangeHeader };
