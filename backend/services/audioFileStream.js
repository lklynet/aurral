import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const AUDIO_CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

function parseRangeHeader(value, size) {
  const match = /^([a-z][a-z0-9+.-]*)=(.*)$/i.exec(String(value || "").trim());
  if (!match || match[1].toLowerCase() !== "bytes" || match[2].includes(",")) return null;

  const rangeMatch = /^(\d*)-(\d*)$/.exec(match[2]);
  if (!rangeMatch) return null;

  const hasStart = rangeMatch[1] !== "";
  const hasEnd = rangeMatch[2] !== "";
  if (!hasStart && !hasEnd) return null;
  if (size <= 0) return { unsatisfiable: true };

  const sizeValue = BigInt(size);
  const startValue = hasStart ? BigInt(rangeMatch[1]) : null;
  const endValue = hasEnd ? BigInt(rangeMatch[2]) : null;
  if (!hasStart && endValue === 0n) return { unsatisfiable: true };

  if (!hasStart) {
    return {
      start: endValue >= sizeValue ? 0 : Number(sizeValue - endValue),
      end: size - 1,
    };
  }

  if (startValue >= sizeValue) return { unsatisfiable: true };
  const start = Number(startValue);
  const end = !hasEnd || endValue >= sizeValue ? size - 1 : Number(endValue);
  if (end < start) return { unsatisfiable: true };
  return { start, end };
}

async function pipeToResponse(filePath, res, options) {
  try {
    await pipeline(fs.createReadStream(filePath, options), res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
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
    await pipeToResponse(filePath, res);
    return true;
  }

  const range = parseRangeHeader(req.headers.range, stat.size);
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    await pipeToResponse(filePath, res);
    return true;
  }
  if (range.unsatisfiable) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    return false;
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  res.setHeader("Content-Length", range.end - range.start + 1);
  await pipeToResponse(filePath, res, range);
  return true;
}

export { parseRangeHeader };
