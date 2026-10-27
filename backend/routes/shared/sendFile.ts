import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import send from "send";
import { asAppError } from "../../../lib/errors.ts";

export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  { contentType, dotfiles }: { contentType: string; dotfiles: "allow" | "deny" },
) {
  return new Promise<boolean>((resolve, reject) => {
    res.once("close", () => resolve(true));
    send(req, encodeURI(path.basename(filePath)), { root: path.dirname(filePath), dotfiles })
      .on("headers", () => res.setHeader("Content-Type", contentType))
      .on("directory", () => resolve(false))
      .on("error", (error: unknown) => {
        if (res.headersSent) res.destroy();
        else if (asAppError(error)?.status === 404) resolve(false);
        else reject(error);
      })
      .pipe(res);
  });
}
