import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import {
  getCustomArtwork,
  removeCustomArtwork,
  saveCustomArtworkUpload,
  saveCustomArtworkUrl,
} from "../../../services/customArtworkService.ts";
import { hasPermission, isAuthRequiredByConfig } from "../../../middleware/auth.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { sendFile } from "../../../services/fileResponses.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import {
  canAccessJobThroughPlaylist,
  canAccessPlaylistType,
  requireFlowAccess,
  requireFlowAccessIfSignedIn,
} from "./utils.ts";
import type { Context } from "hono";
import type { AppEnv } from "../../../middleware/requestUser.ts";

const ARTWORK_UPLOAD_LIMIT = "8mb";

const isImageUpload = <E extends AppEnv>(c: Context<E>) =>
  String(c.req.header("content-type") || "")
    .toLowerCase()
    .startsWith("image/");

const imageBodyLimit = bodyLimit({
  maxSize: 8 * 1024 ** 2,
  onError: (c) =>
    c.json(
      {
        error: "Payload too large",
        message: `Request body exceeds limit (${ARTWORK_UPLOAD_LIMIT})`,
      },
      413,
    ),
});

const limitImageUpload = createMiddleware<AppEnv>(async (c, next) => {
  if (isImageUpload(c)) return imageBodyLimit(c, next);
  await next();
});

const readImageUpload = async <E extends AppEnv>(c: Context<E>) =>
  isImageUpload(c) ? Buffer.from(await c.req.arrayBuffer()) : null;

const getAccessibleJob = (c: Context<AppEnv>) => {
  const job = downloadTracker.getJob(c.req.param("jobId") ?? "");
  return job && canAccessJobThroughPlaylist(c.var.user, job, c.req.query("playlistId"))
    ? job
    : null;
};

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

const requireAccessibleJob = createMiddleware<AppEnv>(async (c, next) => {
  if (!getAccessibleJob(c)) return c.json({ error: "Track not found" }, 404);
  await next();
});

const trackArtworkQuery = validate("query", v.object({ playlistId: v.optional(v.string()) }));

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get("/artwork/:playlistId", requireStreamAuth, requireFlowAccessIfSignedIn, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist artwork not found" }, 404);
    }
    const artwork = await playlistManager.resolveArtworkFile(playlistId);
    if (!artwork) {
      return c.json({ error: "Playlist artwork not found" }, 404);
    }
    const { getArtworkContentTypeForExtension } =
      await import("../../../services/playlistArtworkGenerator.ts");
    c.header("Cache-Control", "private, no-cache, must-revalidate");
    const sent = await sendViaNode(c, sendFile, artwork.safePath, {
      contentType: getArtworkContentTypeForExtension(artwork.extension),
      dotfiles: "allow",
    });
    return sent || c.json({ error: "Playlist artwork not found" }, 404);
  })
  .put("/artwork/:playlistId", requireFlowAccess, limitImageUpload, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    const image = await readImageUpload(c);
    if (!image?.length) {
      return c.json({ error: "Bad Request", message: "Image body is required" }, 400);
    }
    try {
      await playlistManager.saveArtworkUpload(playlistId, image);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return c.json(
        { error: "Bad Request", message: asAppError(error)?.message || "Failed to save artwork" },
        400,
      );
    }
  })
  .delete("/artwork/:playlistId", requireFlowAccess, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    try {
      await playlistManager.removeArtwork(playlistId);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return c.json(
        {
          error: "Bad Request",
          message: asAppError(error)?.message || "Failed to remove artwork",
        },
        400,
      );
    }
  })
  .post("/artwork/:playlistId/generate", requireFlowAccess, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    try {
      await playlistManager.generateArtwork(playlistId);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return c.json(
        {
          error: "Bad Request",
          message: asAppError(error)?.message || "Failed to generate artwork",
        },
        400,
      );
    }
  })
  .get("/track-artwork/:jobId", async (c) => {
    if (!c.var.user && isAuthRequiredByConfig()) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const jobId = c.req.param("jobId");
    const artwork = getAccessibleJob(c) && getCustomArtwork("playlist-track", jobId);
    if (!artwork) return c.json({ error: "Artwork not found" }, 404);
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    const sent = await sendViaNode(c, sendFile, artwork.filePath, {
      contentType: artwork.contentType,
      dotfiles: "deny",
    });
    return sent || c.json({ error: "Artwork not found" }, 404);
  })
  .put(
    "/track-artwork/:jobId",
    requireFlowAccess,
    canEditArtwork,
    trackArtworkQuery,
    requireAccessibleJob,
    limitImageUpload,
    async (c) => {
      const image = await readImageUpload(c);
      if (!image?.length) {
        return c.json({ error: "Image body is required" }, 400);
      }
      try {
        const artwork = await saveCustomArtworkUpload(
          "playlist-track",
          c.req.param("jobId"),
          image,
          c.req.header("content-type"),
        );
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
    "/track-artwork/:jobId/url",
    requireFlowAccess,
    canEditArtwork,
    trackArtworkQuery,
    requireAccessibleJob,
    validate("json", v.object({ url: v.string() })),
    async (c) => {
      try {
        const artwork = await saveCustomArtworkUrl(
          "playlist-track",
          c.req.param("jobId"),
          c.req.valid("json").url,
        );
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
  .delete(
    "/track-artwork/:jobId",
    requireFlowAccess,
    canEditArtwork,
    trackArtworkQuery,
    requireAccessibleJob,
    async (c) => {
      await removeCustomArtwork("playlist-track", c.req.param("jobId"));
      return c.json({ ok: true }, 200);
    },
  );
