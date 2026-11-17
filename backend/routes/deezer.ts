import { Hono } from "hono";
import { http } from "../../lib/http.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import * as v from "valibot";
import { requireStreamAuth } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import { deezerPreviewLinkFor, getDeezerPreviewLink } from "../services/apiClients/deezer.ts";

const previewNotFound = { error: "Preview not found" };

export default new Hono<AppEnv>()
  .basePath("/deezer")
  .get(
    "/preview",
    requireStreamAuth,
    validate("query", v.object({ artist: v.string(), track: v.string() })),
    async (c) => {
      const { artist, track } = c.req.valid("query");
      const link = await deezerPreviewLinkFor({ artistName: artist, trackName: track }).catch(
        () => null,
      );
      c.header("Cache-Control", "no-store");
      return link ? c.redirect(link, 302) : c.json(previewNotFound, 404);
    },
  )
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
