import path from "node:path";

const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"]);

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

export function audioContentType(format) {
  const normalized = String(format).toLowerCase();
  return AUDIO_CONTENT_TYPES[normalized] || `audio/${normalized}`;
}

export function streamAudioFile(res, filePath) {
  const absolutePath = path.resolve(String(filePath));
  const contentType = AUDIO_CONTENT_TYPES[path.extname(absolutePath).slice(1).toLowerCase()];
  return new Promise((resolve, reject) => {
    res.sendFile(
      path.basename(absolutePath),
      {
        root: path.dirname(absolutePath),
        dotfiles: "allow",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      },
      (error) => {
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
