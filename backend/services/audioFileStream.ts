import path from "node:path";
import type { Response } from "express";
import { isOwnKey } from "../../lib/ownKey.ts";

type SendFileError = Error & { status?: number; headers?: Record<string, string>; code?: string };

const MISSING_FILE_CODES = new Set<string | undefined>([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
]);

const AUDIO_CONTENT_TYPES = {
  aiff: "audio/x-aiff",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
};

const knownContentType = (format: string) =>
  isOwnKey(AUDIO_CONTENT_TYPES, format) ? AUDIO_CONTENT_TYPES[format] : undefined;

export function audioContentType(format: string) {
  const normalized = String(format).toLowerCase();
  return knownContentType(normalized) || `audio/${normalized}`;
}

export function streamAudioFile(res: Response, filePath: string) {
  const absolutePath = path.resolve(String(filePath));
  const contentType = knownContentType(path.extname(absolutePath).slice(1).toLowerCase());
  return new Promise((resolve, reject) => {
    res.sendFile(
      path.basename(absolutePath),
      {
        root: path.dirname(absolutePath),
        dotfiles: "allow",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      },
      (error: SendFileError | undefined) => {
        if (!error || res.headersSent) return resolve(true);
        if (error.status === 416) {
          res.status(416).set(error.headers).end();
          return resolve(true);
        }
        if (error.status === 404 || MISSING_FILE_CODES.has(error.code)) return resolve(false);
        return reject(error);
      },
    );
  });
}
