import { Hono } from "hono";
import { http } from "../../lib/http.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { getDeezerPreviewLink } from "../services/apiClients/index.ts";

const previewNotFound = { error: "Preview not found" };

export default new Hono<AppEnv>()
  .basePath("/deezer")
  .get("/preview/:file{[^/]+\\.mp3}", async (c) => {
    const trackId = c.req.param("file").slice(0, -".mp3".length);
    if (!/^\d{1,20}$/.test(trackId)) return c.json(previewNotFound, 404);
    try {
      const link = await getDeezerPreviewLink(trackId);
      if (!link) return c.json(previewNotFound, 404);
      c.header("Cache-Control", "no-store");
      if (c.req.query("download") === undefined) return c.redirect(link, 302);
      const clip = await http.get(link, { responseType: "buffer", timeoutMs: 20_000 });
      if (!Buffer.isBuffer(clip.data)) return c.json(previewNotFound, 404);
      return c.body(new Uint8Array(clip.data), 200, { "Content-Type": "audio/mpeg" });
    } catch {
      return c.json({ error: "Deezer is unavailable" }, 502);
    }
  });
