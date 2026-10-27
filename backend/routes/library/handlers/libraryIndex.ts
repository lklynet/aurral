import { Hono } from "hono";
import * as v from "valibot";
import { isAuthRequiredByConfig } from "../../../middleware/auth.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requireUserAccount } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { sendBuffer } from "../../../services/fileResponses.ts";
import { getLibraryAlbumArtwork } from "../../../services/libraryAlbumArtwork.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import {
  buildCustomArtworkUrl,
  getCustomArtworkMap,
} from "../../../services/customArtworkService.ts";
import {
  type getLibrary,
  type LibraryArtist,
  getLibraryFavoriteTargetKeys,
  getLibraryPage,
  LIBRARY_VIEW,
} from "../../../services/libraryQueryService.ts";
import {
  getStarredIdentityKeys,
  getStarredWithLibrary,
  restoreStars,
  starMany,
  unstarMany,
} from "../../../services/subsonicLibraryService.ts";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
  scheduleLibraryScan,
} from "../../../services/libraryScanWorker.ts";
import { asAppError } from "../../../../lib/errors.ts";

const isFilesystemPathKey = (key: string) => key.toLowerCase().endsWith("path");

type FilesystemPathless<T> = T extends readonly (infer U)[]
  ? FilesystemPathless<U>[]
  : T extends object
    ? {
        [
          K in keyof T as K extends string ? (Lowercase<K> extends `${string}path` ? never : K) : K
        ]: FilesystemPathless<T[K]>;
      }
    : T;

export function stripFilesystemPaths<T>(value: T): FilesystemPathless<T>;
export function stripFilesystemPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFilesystemPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isFilesystemPathKey(key))
      .map(([key, entry]) => [key, stripFilesystemPaths(entry)]),
  );
}

export function resolveAvailableOnly(queryValue: unknown) {
  if (queryValue === "true") return true;
  if (queryValue === "false") return false;
  return LIBRARY_VIEW;
}

function getAlbumCoverUrl(album: LibraryCollections["albums"][number]) {
  const image = (Array.isArray(album?.metadata?.images) ? album.metadata.images : []).find(
    (entry) => /^https?:\/\//i.test(entry?.remoteUrl || entry?.imageUrl || entry?.url || ""),
  );
  const source = image?.remoteUrl || image?.imageUrl || image?.url;
  if (/^https?:\/\//i.test(source || "")) return buildImageProxyUrl(source);
  return album.available && !album.mbid && !album.releaseGroupMbid
    ? `/api/library/albums/${encodeURIComponent(album.id)}/cover`
    : null;
}

const publicEntity = <T extends { identityKey: string }>(
  kind: string,
  entity: T,
  favoriteKeys: Set<string> | null,
): T & { userFavorite?: boolean } =>
  favoriteKeys
    ? { ...entity, userFavorite: favoriteKeys.has(`${kind}:${entity.identityKey}`) }
    : { ...entity };

const publicAlbum = (
  album: LibraryCollections["albums"][number] & { coverUrl?: string | null },
  favoriteKeys: Set<string> | null,
  customArtwork: number | undefined,
) => {
  const defaultCoverUrl = album.coverUrl || getAlbumCoverUrl(album);
  return {
    ...album,
    coverUrl: customArtwork
      ? buildCustomArtworkUrl("album", album.id, customArtwork)
      : defaultCoverUrl,
    ...(customArtwork && defaultCoverUrl ? { defaultCoverUrl } : {}),
    ...(customArtwork
      ? { customArtworkUrl: buildCustomArtworkUrl("album", album.id, customArtwork) }
      : {}),
    ...(favoriteKeys ? { userFavorite: favoriteKeys.has(`album:${album.identityKey}`) } : {}),
  };
};

export function buildPublicLibrary(
  library: LibraryCollections,
  favoriteKeys: Set<string> | null = null,
) {
  const albumArtwork = getCustomArtworkMap(
    "album",
    library.albums.map((album) => album.id),
  );
  const trackArtwork = getCustomArtworkMap(
    "track",
    library.tracks.map((track) => track.id),
  );
  return {
    artists: library.artists.map((artist) => publicEntity("artist", artist, favoriteKeys)),
    albums: library.albums.map((album) =>
      publicAlbum(album, favoriteKeys, albumArtwork.get(String(album.id))),
    ),
    tracks: library.tracks.map((track) => {
      const item = publicEntity("song", track, favoriteKeys);
      const customArtwork = trackArtwork.get(String(track.id));
      return customArtwork
        ? {
            ...item,
            artworkUrl: buildCustomArtworkUrl("track", track.id, customArtwork),
            customArtworkUrl: buildCustomArtworkUrl("track", track.id, customArtwork),
          }
        : item;
    }),
  };
}

function toPublicLibrary(library: LibraryCollections, favoriteKeys: Set<string> | null = null) {
  return stripFilesystemPaths(buildPublicLibrary(library, favoriteKeys));
}

export function toPublicLibraryPage(page: LibraryPage, favoriteKeys: Set<string> | null = null) {
  const collections = toPublicLibrary(page, favoriteKeys);
  const stripped = stripFilesystemPaths(page);
  switch (stripped.kind) {
    case "artists":
      return { ...stripped, ...collections, items: collections.artists };
    case "albums":
      return { ...stripped, ...collections, items: collections.albums };
    case "tracks":
      return { ...stripped, ...collections, items: collections.tracks };
    case "genres":
      return { ...stripped, ...collections, items: stripped.items };
  }
}

type LibraryCollections = Pick<ReturnType<typeof getLibrary>, "albums" | "tracks"> & {
  artists: LibraryArtist[];
};
type LibraryPage = ReturnType<typeof getLibraryPage>;

const refreshInput = v.object({ mode: v.optional(v.picklist(["quick", "full"])) });

const pageQuery = v.object({
  kind: v.optional(v.string()),
  pageSize: v.optional(v.string()),
  page: v.optional(v.string()),
  source: v.optional(v.string()),
  availableOnly: v.optional(v.string()),
  query: v.optional(v.string()),
  genre: v.optional(v.string()),
  sort: v.optional(v.string()),
  direction: v.optional(v.string()),
  artistId: v.optional(v.string()),
  albumId: v.optional(v.string()),
});

const favoritesInput = v.object({
  ids: v.optional(v.array(v.string())),
  starred: v.optional(v.boolean()),
});

const restoreInput = v.object({
  favorites: v.optional(v.array(v.object({ id: v.string(), starredAt: v.number() }))),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/albums/:albumId/cover", async (c) => {
    if (!c.var.user && isAuthRequiredByConfig()) return c.json({ error: "Unauthorized" }, 401);
    try {
      const artwork = await getLibraryAlbumArtwork(c.req.param("albumId"));
      if (!artwork) return c.json({ error: "Album cover not found" }, 404);
      c.header("Cache-Control", "private, max-age=3600");
      return (
        (await sendViaNode(c, sendBuffer, artwork.buffer, artwork.contentType)) ??
        c.json({ error: "Failed to read album cover" }, 500)
      );
    } catch {
      return c.json({ error: "Failed to read album cover" }, 500);
    }
  })
  .post("/refresh", requireAuth, validate("json", refreshInput), (c) => {
    const jobId = scheduleLibraryScan({ force: c.req.valid("json").mode === "full" });
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
  .get("/canonical", noCache, validate("query", pageQuery), (c) => {
    const user = c.var.user;
    const query = c.req.valid("query");
    try {
      const favoriteKeys = user ? getStarredIdentityKeys(user) : null;
      const kind = query.kind?.trim() ?? "";
      const pageSize = query.pageSize === undefined ? NaN : Number(query.pageSize);
      if (!kind || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return c.json({ error: "kind and pageSize (1-100) are required" }, 400);
      }
      return c.json(
        toPublicLibraryPage(
          getLibraryPage({
            source: query.source,
            availableOnly: resolveAvailableOnly(query.availableOnly),
            kind,
            page: query.page,
            pageSize,
            query: query.query,
            genre: query.genre,
            sort: query.sort,
            direction: query.direction,
            artistId: query.artistId,
            albumId: query.albumId,
          }),
          favoriteKeys,
        ),
        200,
      );
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
  })
  .get("/favorites", requireAuth, noCache, (c) => {
    const { starred, library } = getStarredWithLibrary(c.var.user);
    return c.json({ ...starred, library: toPublicLibrary(library) }, 200);
  })
  .post(
    "/favorites",
    requireAuth,
    requireUserAccount,
    noCache,
    validate("json", favoritesInput),
    (c) => {
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
        if (!starMany(user, ids, { skipLibraryValidation: true })) {
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

export { toPublicLibrary };
