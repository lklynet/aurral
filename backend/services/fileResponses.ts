import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import send from "send";
import { asAppError } from "../../lib/errors.ts";

const MISSING_FILE_CODES = new Set<string | number | undefined>([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
]);

export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  { contentType, dotfiles = "allow" }: { contentType?: string; dotfiles?: "allow" | "deny" } = {},
) {
  const absolutePath = path.resolve(filePath);
  return new Promise<boolean>((resolve, reject) => {
    res.once("close", () => resolve(true));
    send(req, encodeURI(path.basename(absolutePath)), {
      root: path.dirname(absolutePath),
      dotfiles,
    })
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

export function sendBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  body: Uint8Array,
  contentType: string,
) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", body.byteLength);
  res.end(req.method === "HEAD" ? undefined : body);
  return Promise.resolve(true);
}
