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
import { getArtworkContentTypeForExtension } from "../../../services/playlistArtworkGenerator.ts";
import { getPlaylistArtworkState } from "../../../services/playlistArtworkState.ts";
import { PLAYLIST_COVER_TEMPLATES } from "../../../services/playlistCoverTemplates.ts";
import {
  canAccessJobThroughPlaylist,
  canAccessPlaylistType,
  requirePlaylistAccess,
  requirePlaylistAccessIfSignedIn,
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

const coverStyle = v.picklist(["artist", "simple"], "Choose artist or simple cover art");

const coverPick = {
  style: coverStyle,
  artistKey: v.optional(
    v.pipe(
      v.nullable(v.string()),
      v.transform((key) => key || null),
    ),
    null,
  ),
  template: v.picklist(PLAYLIST_COVER_TEMPLATES, "Invalid cover choice"),
};

const badRequest = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) =>
  c.json({ error: "Bad Request", message: asAppError(error)?.message || fallback }, 400);

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get("/artwork/:playlistId", requireStreamAuth, requirePlaylistAccessIfSignedIn, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist artwork not found" }, 404);
    }
    const artwork = await playlistManager.resolveArtworkFile(playlistId);
    if (!artwork) {
      return c.json({ error: "Playlist artwork not found" }, 404);
    }
    c.header("Cache-Control", "private, no-cache, must-revalidate");
    const sent = await sendViaNode(c, sendFile, artwork.safePath, {
      contentType: getArtworkContentTypeForExtension(artwork.extension),
      dotfiles: "allow",
    });
    return sent || c.json({ error: "Playlist artwork not found" }, 404);
  })
  .put("/artwork/:playlistId", requirePlaylistAccess, limitImageUpload, async (c) => {
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
      return badRequest(c, error, "Failed to save artwork");
    }
  })
  .delete("/artwork/:playlistId", requirePlaylistAccess, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    try {
      await playlistManager.removeArtwork(playlistId);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return badRequest(c, error, "Failed to remove artwork");
    }
  })
  .get(
    "/artwork/:playlistId/preview",
    requireStreamAuth,
    requirePlaylistAccessIfSignedIn,
    validate("query", v.object({ ...coverPick, title: v.optional(v.string()) })),
    async (c) => {
      const playlistId = c.req.param("playlistId");
      if (!canAccessPlaylistType(c.var.user, playlistId)) {
        return c.json({ error: "Playlist artwork not found" }, 404);
      }
      const { title = "", ...pick } = c.req.valid("query");
      try {
        const image = await playlistManager.previewArtwork(playlistId, title.slice(0, 200), pick);
        return c.body(new Uint8Array(image), 200, {
          "Content-Type": "image/webp",
          "Cache-Control": "private, max-age=3600",
        });
      } catch (error) {
        return badRequest(c, error, "Failed to preview cover");
      }
    },
  )
  .get("/artwork/:playlistId/pick", requirePlaylistAccess, (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    return c.json({ pick: playlistManager.getArtworkPick(playlistId) }, 200);
  })
  .post(
    "/artwork/:playlistId/shuffle",
    requirePlaylistAccess,
    validate("json", v.object({ style: coverStyle, previous: v.nullish(v.object(coverPick)) })),
    async (c) => {
      const playlistId = c.req.param("playlistId");
      if (!canAccessPlaylistType(c.var.user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const { style, previous } = c.req.valid("json");
      try {
        const pick = await playlistManager.shuffleArtwork(playlistId, style, previous ?? null);
        return c.json({ pick }, 200);
      } catch (error) {
        return badRequest(c, error, "Failed to shuffle cover");
      }
    },
  )
  .post("/artwork/:playlistId/restore", requirePlaylistAccess, async (c) => {
    const playlistId = c.req.param("playlistId");
    if (!canAccessPlaylistType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    try {
      await playlistManager.restoreOriginalArtwork(playlistId);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return badRequest(c, error, "Failed to restore original cover");
    }
  })
  .post(
    "/artwork/:playlistId/generate",
    requirePlaylistAccess,
    validate(
      "json",
      v.object({ style: v.optional(coverStyle, "artist"), pick: v.nullish(v.object(coverPick)) }),
    ),
    async (c) => {
      const playlistId = c.req.param("playlistId");
      if (!canAccessPlaylistType(c.var.user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const { style, pick } = c.req.valid("json");
      try {
        await playlistManager.generateArtwork(playlistId, style, pick ?? null);
        return c.json(
          { ok: true, fallback: getPlaylistArtworkState(playlistId)?.fallbackSignature != null },
          200,
        );
      } catch (error) {
        return badRequest(c, error, "Failed to generate artwork");
      }
    },
  )
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
    requirePlaylistAccess,
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
    requirePlaylistAccess,
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
    requirePlaylistAccess,
    canEditArtwork,
    trackArtworkQuery,
    requireAccessibleJob,
    async (c) => {
      await removeCustomArtwork("playlist-track", c.req.param("jobId"));
      return c.json({ ok: true }, 200);
    },
  );
