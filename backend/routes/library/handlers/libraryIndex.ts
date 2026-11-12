import { Hono, type Context } from "hono";
import { createFactory } from "hono/factory";
import * as v from "valibot";
import { isAuthRequiredByConfig } from "../../../services/auth.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requireUserAccount } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { sendFile } from "../../../services/fileResponses.ts";
import { getLibraryArtwork, type LibraryArtworkKind } from "../../../services/libraryArtwork.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import {
  getLibraryFavoriteTargetKeys,
  getLibraryPage,
  LIBRARY_VIEW,
} from "../../../services/libraryQueryService.ts";
import {
  getStarredIdentityKeys,
  getLibraryFavorites,
  restoreStars,
  starMany,
  unstarMany,
} from "../../../services/subsonicLibraryService.ts";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
  scheduleLibraryItemScan,
  scheduleLibraryScan,
} from "../../../services/libraryScanWorker.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { LIBRARY_STATUSES } from "../../../../lib/libraryStatus.ts";
import { getLibraryArtistPlays } from "../../../services/artistListening.ts";
import { toPublicLibrary, toPublicLibraryPage } from "../../../services/publicLibrary.ts";

export function resolveAvailableOnly(queryValue: unknown) {
  if (queryValue === "true") return true;
  if (queryValue === "false") return false;
  return LIBRARY_VIEW;
}

async function sendLibraryArtwork(c: Context<AppEnv>, kind: LibraryArtworkKind, id: string) {
  if (!c.var.user && isAuthRequiredByConfig()) return c.json({ error: "Unauthorized" }, 401);
  const notFound = () => {
    c.header("Cache-Control", "private, max-age=300");
    return c.json({ error: "Artwork not found" }, 404);
  };
  const artwork = await getLibraryArtwork(kind, id).catch(() => null);
  if (!artwork) return notFound();
  c.header(
    "Cache-Control",
    c.req.query("v") ? "private, max-age=31536000, immutable" : "private, max-age=3600",
  );
  return (
    (await sendViaNode(c, sendFile, artwork.filePath, {
      contentType: artwork.contentType,
      dotfiles: "deny",
    })) ?? notFound()
  );
}

const libraryItemId = v.pipe(v.number(), v.integer(), v.minValue(1));
const refreshInput = v.object({
  mode: v.optional(v.picklist(["quick", "full"])),
  albumId: v.optional(libraryItemId),
  artistId: v.optional(libraryItemId),
});

const pageQuery = v.object({
  kind: v.optional(v.string()),
  pageSize: v.optional(v.string()),
  page: v.optional(v.string()),
  source: v.optional(v.string()),
  availableOnly: v.optional(v.string()),
  query: v.optional(v.string()),
  genre: v.optional(v.string()),
  status: v.optional(v.picklist(LIBRARY_STATUSES)),
  sort: v.optional(v.string()),
  direction: v.optional(v.string()),
  artistId: v.optional(v.string()),
  albumId: v.optional(v.string()),
  compact: v.optional(v.string()),
});

const favoritesInput = v.object({
  ids: v.optional(v.array(v.string())),
  starred: v.optional(v.boolean()),
});

const factory = createFactory<AppEnv>();

const restoreInput = v.object({
  favorites: v.optional(v.array(v.object({ id: v.string(), starredAt: v.number() }))),
});

const libraryPage = factory.createHandlers(noCache, validate("query", pageQuery), (c) => {
  const user = c.var.user;
  const query = c.req.valid("query");
  try {
    const favoriteKeys = user ? getStarredIdentityKeys(user) : null;
    const kind = query.kind?.trim() ?? "";
    const pageSize = query.pageSize === undefined ? NaN : Number(query.pageSize);
    if (!kind || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return c.json({ error: "kind and pageSize (1-100) are required" }, 400);
    }
    const page = toPublicLibraryPage(
      getLibraryPage({
        source: query.source,
        availableOnly: resolveAvailableOnly(query.availableOnly),
        kind,
        page: query.page,
        pageSize,
        query: query.query,
        genre: query.genre,
        status: query.status,
        sort: query.sort,
        direction: query.direction,
        artistId: query.artistId,
        albumId: query.albumId,
        userId: user?.id ?? null,
      }),
      favoriteKeys,
    );
    if (query.compact !== "true" || page.kind === "genres") return c.json(page, 200);
    const { items, genres, ...compactPage } = page;
    return c.json(compactPage, 200);
  } catch (error) {
    const failure = asAppError(error);
    if (
      failure?.message.startsWith("Unsupported library source:") ||
      failure?.message.startsWith("Unsupported library page kind:")
    ) {
      return c.json({ error: failure.message }, 400);
    }
    return c.json({ error: "Failed to query library", message: failure?.message }, 500);
  }
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/albums/:albumId/cover", (c) => sendLibraryArtwork(c, "album", c.req.param("albumId")))
  .get("/artists/:artistId/cover", (c) => sendLibraryArtwork(c, "artist", c.req.param("artistId")))
  .get("/artists/:artistId/plays", requireAuth, noCache, (c) => {
    const plays = getLibraryArtistPlays(c.var.user.id, Number(c.req.param("artistId")));
    if (plays === null) return c.json({ error: "Artist not found" }, 404);
    return c.json({ plays }, 200);
  })
  .post("/refresh", requireAuth, validate("json", refreshInput), (c) => {
    const { mode, albumId, artistId } = c.req.valid("json");
    const jobId = albumId
      ? scheduleLibraryItemScan({ albumId })
      : artistId
        ? scheduleLibraryItemScan({ artistId })
        : scheduleLibraryScan({ force: mode === "full" });
    if (jobId === null) return c.json({ error: "No files to rescan" }, 404);
    return c.json({ queued: true, jobId, status: getLibraryScanStatus(jobId) }, 202);
  })
  .get("/refresh", requireAuth, noCache, (c) => {
    const jobId = getScheduledLibraryScanJobId();
    return c.json({ jobId, status: jobId == null ? null : getLibraryScanStatus(jobId) }, 200);
  })
  .get("/refresh/:jobId", requireAuth, noCache, (c) => {
    const status = getLibraryScanStatus(c.req.param("jobId"));
    if (!status || status.status === "unknown") {
      return c.json({ error: "Library scan not found" }, 404);
    }
    return c.json(status, 200);
  })
  .get("/", ...libraryPage)
  .get("/favorites", requireAuth, noCache, (c) => {
    const { library, ...favorites } = getLibraryFavorites(c.var.user);
    return c.json({ ...favorites, library: toPublicLibrary(library) }, 200);
  })
  .post(
    "/favorites",
    requireAuth,
    requireUserAccount,
    noCache,
    validate("json", favoritesInput),
    async (c) => {
      const user = c.var.user;
      const { ids: rawIds = [], starred } = c.req.valid("json");
      const ids = rawIds.map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0 || ids.length > 100 || starred === undefined) {
        return c.json({ error: "ids and starred are required" }, 400);
      }
      if (starred) {
        const libraryIds = ids.filter((id) => /^(artist|album|song):.+/.test(id));
        const validTargets = getLibraryFavoriteTargetKeys(libraryIds);
        if (libraryIds.some((id) => !validTargets.has(id))) {
          return c.json({ error: "Invalid favorite target" }, 400);
        }
        if (!(await starMany(user, ids, { skipLibraryValidation: true }))) {
          return c.json({ error: "Invalid favorite target" }, 400);
        }
      }
      const removed = starred ? undefined : unstarMany(user, ids);
      if (removed === false) return c.json({ error: "Invalid favorite target" }, 400);
      return c.json({ changedIds: ids, removed }, 200);
    },
  )
  .post(
    "/favorites/restore",
    requireAuth,
    requireUserAccount,
    noCache,
    validate("json", restoreInput),
    (c) => {
      const { favorites } = c.req.valid("json");
      if (!favorites || favorites.length > 500 || !restoreStars(c.var.user, favorites)) {
        return c.json({ error: "favorites must list removed favorites to restore" }, 400);
      }
      return c.json({ restoredIds: favorites.map((entry) => entry.id) }, 200);
    },
  );
