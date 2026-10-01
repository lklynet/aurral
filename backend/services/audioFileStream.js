import path from "node:path";

const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"]);

export function streamAudioFile(res, filePath) {
  const absolutePath = path.resolve(String(filePath));
  return new Promise((resolve, reject) => {
    res.sendFile(
      path.basename(absolutePath),
      { root: path.dirname(absolutePath), dotfiles: "allow" },
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
