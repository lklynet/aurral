import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { sendFile } from "../services/fileResponses.ts";
import { findCachedImage, warmImageProxy } from "../services/imageProxyService.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";

const imageNotFound = { error: "Image not found" };

export default new Hono<AppEnv>()
  .basePath("/image-proxy")
  .post(
    "/",
    requireAuth,
    validate("json", v.object({ src: v.optional(v.pipe(v.string(), v.trim()), "") })),
    async (c) => {
      const { src } = c.req.valid("json");
      if (!/^https?:\/\//i.test(src)) {
        return c.json({ error: "An http or https image URL is required" }, 400);
      }
      try {
        const cached = await warmImageProxy(src);
        return cached?.localUrl
          ? c.json({ url: cached.localUrl }, 200)
          : c.json(imageNotFound, 404);
      } catch {
        return c.json(imageNotFound, 404);
      }
    },
  )
  .get("/:cacheKey", async (c) => {
    const image = await findCachedImage(c.req.param("cacheKey"));
    if (!image) return c.json(imageNotFound, 404);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    const sent = await sendViaNode(c, sendFile, image.imagePath, {
      contentType: image.meta.contentType || "image/jpeg",
      dotfiles: "allow",
    });
    return sent || c.json(imageNotFound, 404);
  });
