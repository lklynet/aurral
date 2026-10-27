import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { db } from "../../../config/db-sqlite.ts";
import { hasPermission, isAuthRequiredByConfig } from "../../../middleware/auth.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  getCustomArtwork,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} from "../../../services/customArtworkService.ts";
import { sendFile } from "../../../services/fileResponses.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import { asAppError } from "../../../../lib/errors.ts";

const isImageUpload = (contentType: string | undefined) =>
  String(contentType || "")
    .toLowerCase()
    .startsWith("image/");

const imageBodyLimit = bodyLimit({
  maxSize: 8 * 1024 * 1024,
  onError: (c) =>
    c.json({ error: "Payload too large", message: "Request body exceeds limit (8mb)" }, 413),
});

const canEditArtwork = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.var.user;
  if (
    user?.role !== "admin" &&
    !hasPermission(user, "addAlbum") &&
    !hasPermission(user, "changeMonitoring")
  ) {
    return c.json(
      { error: "Forbidden", message: "Permission required: addAlbum or changeMonitoring" },
      403,
    );
  }
  await next();
});

function entityExists(kind: string, id: string) {
  if (kind === "album") {
    return Boolean(db.prepare("SELECT 1 FROM library_albums WHERE id = ?").get(id));
  }
  if (kind === "track") {
    return Boolean(db.prepare("SELECT 1 FROM library_tracks WHERE id = ?").get(id));
  }
  return false;
}

const validateTarget = createMiddleware<AppEnv>(async (c, next) => {
  if (!entityExists(c.req.param("kind") ?? "", c.req.param("id") ?? "")) {
    return c.json({ error: "Library item not found" }, 404);
  }
  await next();
});

const urlInput = v.object({ url: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/artwork/:kind/:id", async (c) => {
    if (!c.var.user && isAuthRequiredByConfig()) return c.json({ error: "Unauthorized" }, 401);
    const { kind, id } = c.req.param();
    const artwork = entityExists(kind, id) ? getCustomArtwork(kind, id) : null;
    if (!artwork) return c.json({ error: "Artwork not found" }, 404);
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return (
      (await sendViaNode(c, sendFile, artwork.filePath, {
        contentType: artwork.contentType,
        dotfiles: "deny",
      })) ?? c.json({ error: "Artwork not found" }, 404)
    );
  })
  .put(
    "/artwork/:kind/:id",
    requireAuth,
    canEditArtwork,
    validateTarget,
    (c, next) => (isImageUpload(c.req.header("content-type")) ? imageBodyLimit(c, next) : next()),
    async (c) => {
      const contentType = c.req.header("content-type");
      const body = isImageUpload(contentType) ? Buffer.from(await c.req.arrayBuffer()) : null;
      if (!body?.length) return c.json({ error: "Image body is required" }, 400);
      const { kind, id } = c.req.param();
      try {
        const artwork = await saveCustomArtworkUpload(kind, id, body, contentType);
        return c.json({ ok: true, updatedAt: artwork.updatedAt }, 200);
      } catch (error) {
        return c.json(
          {
            error: "Failed to save artwork",
            message: asAppError(error)?.message || "The image could not be saved",
          },
          400,
        );
      }
    },
  )
  .put(
    "/artwork/:kind/:id/url",
    requireAuth,
    canEditArtwork,
    validateTarget,
    validate("json", urlInput),
    async (c) => {
      const { kind, id } = c.req.param();
      try {
        const artwork = await saveCustomArtworkUrl(kind, id, c.req.valid("json").url);
        return c.json({ ok: true, updatedAt: artwork.updatedAt }, 200);
      } catch (error) {
        return c.json(
          {
            error: "Failed to save artwork",
            message: asAppError(error)?.message || "The image could not be downloaded",
          },
          400,
        );
      }
    },
  )
  .delete("/artwork/:kind/:id", requireAuth, canEditArtwork, validateTarget, async (c) => {
    const { kind, id } = c.req.param();
    await removeCustomArtwork(kind, id);
    return c.json({ ok: true }, 200);
  });
