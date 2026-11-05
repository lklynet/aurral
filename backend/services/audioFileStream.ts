import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isOwnKey } from "../../lib/ownKey.ts";
import { fileLoudness } from "./audioLoudness.ts";
import { sendFile } from "./fileResponses.ts";

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

export async function sendAudioFile(req: IncomingMessage, res: ServerResponse, filePath: string) {
  if (req.method === "HEAD") {
    const lufs = await fileLoudness(filePath);
    if (lufs != null) res.setHeader("X-Aurral-Loudness", lufs.toFixed(1));
  }
  return sendFile(req, res, filePath, {
    contentType: knownContentType(path.extname(filePath).slice(1).toLowerCase()),
  });
}
