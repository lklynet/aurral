import fs from "node:fs/promises";
import type { Context } from "hono";
import { resizedImageWidth } from "../../../lib/imageSizes.ts";
import { sendFile } from "../../services/fileResponses.ts";
import { resizeImageFile } from "../../services/imageProxyService.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { sendViaNode } from "./sendViaNode.ts";

export async function sendImageFile<E extends AppEnv>(
  c: Context<E>,
  filePath: string,
  requestedWidth: number,
  options?: Parameters<typeof sendFile>[3],
) {
  const width = resizedImageWidth(requestedWidth);
  const stat = width ? await fs.stat(filePath).catch(() => null) : null;
  if (width && stat?.isFile()) {
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${width}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
    const resized = await resizeImageFile(filePath, width).catch(() => null);
    if (resized) {
      return c.body(new Uint8Array(resized), 200, { "Content-Type": "image/webp", ETag: etag });
    }
  }
  return sendViaNode(c, sendFile, filePath, options);
}
