import { Hono } from "hono";
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
      return c.redirect(link, 302);
    } catch {
      return c.json({ error: "Deezer is unavailable" }, 502);
    }
  });
