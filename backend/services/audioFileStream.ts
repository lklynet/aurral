import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import send from "send";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";

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

export function sendAudioFile(req: IncomingMessage, res: ServerResponse, filePath: string) {
  const absolutePath = path.resolve(filePath);
  const contentType = knownContentType(path.extname(absolutePath).slice(1).toLowerCase());
  return new Promise<boolean>((resolve, reject) => {
    res.once("close", () => resolve(true));
    send(req, encodeURI(absolutePath), { dotfiles: "allow" })
      .on("headers", () => {
        if (contentType) res.setHeader("Content-Type", contentType);
      })
      .on("directory", () => resolve(false))
      .on("error", (error: unknown) => {
        const failure = asAppError(error);
        if (res.headersSent) {
          res.destroy();
        } else if (failure?.status === 416) {
          res.statusCode = 416;
          res.end();
        } else if (failure?.status === 404 || MISSING_FILE_CODES.has(failure?.code)) {
          resolve(false);
        } else {
          reject(error);
        }
      })
      .pipe(res);
  });
}
