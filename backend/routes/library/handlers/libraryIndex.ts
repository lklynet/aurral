import type { Router } from "express";
import { noCache } from "../../../middleware/cache.ts";
import { verifyTokenAuth } from "../../../middleware/auth.ts";
import { getLibraryAlbumArtwork } from "../../../services/libraryAlbumArtwork.ts";
import { requireAuth, requireUserAccount } from "../../../middleware/requirePermission.ts";
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

export const publicLibraryJsonReplacer = (key: string, value: unknown) =>
  isFilesystemPathKey(key) ? undefined : value;

const publicEntity = <T extends { identityKey: string }>(
  kind: string,
  entity: T,
  favoriteKeys: Set<string> | null,
) =>
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

const LIBRARY_REFRESH_MODES = new Set(["quick", "full"]);

type LibraryCollections = Pick<ReturnType<typeof getLibrary>, "albums" | "tracks"> & {
  artists: LibraryArtist[];
};
type LibraryPage = ReturnType<typeof getLibraryPage>;

export function registerLibraryIndex(router: Router) {
  router.get<"/albums/:albumId/cover">("/albums/:albumId/cover", async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const artwork = await getLibraryAlbumArtwork(req.params.albumId);
      if (!artwork) return res.status(404).json({ error: "Album cover not found" });
      res.set("Cache-Control", "private, max-age=3600");
      return res.type(artwork.contentType).send(artwork.buffer);
    } catch {
      return res.status(500).json({ error: "Failed to read album cover" });
    }
  });

  router.post("/refresh", requireAuth, (req, res) => {
    const mode = req.body?.mode ?? "quick";
    if (!LIBRARY_REFRESH_MODES.has(mode)) {
      return res.status(400).json({ error: "Invalid library refresh mode" });
    }
    const jobId = scheduleLibraryScan({ force: mode === "full" });
    res.status(202).json({
      queued: true,
      jobId,
      status: getLibraryScanStatus(jobId),
    });
  });

  router.get("/refresh", requireAuth, noCache, (_req, res) => {
    const jobId = getScheduledLibraryScanJobId();
    return res.json({
      jobId,
      status: jobId == null ? null : getLibraryScanStatus(jobId),
    });
  });

  router.get<"/refresh/:jobId">("/refresh/:jobId", requireAuth, noCache, (req, res) => {
    const status = getLibraryScanStatus(req.params.jobId);
    if (!status || status.status === "unknown") {
      return res.status(404).json({ error: "Library scan not found" });
    }
    return res.json(status);
  });

  router.get("/canonical", noCache, (req, res) => {
    try {
      const favoriteKeys = req.user ? getStarredIdentityKeys(req.user) : null;
      const kind = typeof req.query.kind === "string" ? req.query.kind.trim() : "";
      const requestedPageSize =
        typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : NaN;
      if (
        !kind ||
        !Number.isSafeInteger(requestedPageSize) ||
        requestedPageSize < 1 ||
        requestedPageSize > 100
      ) {
        return res.status(400).json({
          error: "kind and pageSize (1-100) are required",
        });
      }
      const { artistId, albumId } = req.query;
      if (
        (artistId !== undefined && typeof artistId !== "string") ||
        (albumId !== undefined && typeof albumId !== "string")
      ) {
        return res.status(400).json({
          error: "artistId and albumId must each be a single value",
        });
      }
      return res.json(
        toPublicLibraryPage(
          getLibraryPage({
            source: req.query.source,
            availableOnly: resolveAvailableOnly(req.query.availableOnly),
            kind,
            page: req.query.page,
            pageSize: requestedPageSize,
            query: req.query.query,
            genre: req.query.genre,
            sort: req.query.sort,
            direction: req.query.direction,
            artistId,
            albumId,
          }),
          favoriteKeys,
        ),
      );
    } catch (error) {
      const failure = asAppError(error);
      if (
        failure?.message.startsWith("Unsupported library source:") ||
        failure?.message.startsWith("Unsupported library page kind:")
      ) {
        return res.status(400).json({ error: failure?.message });
      }
      return res.status(500).json({
        error: "Failed to query library",
        message: failure?.message,
      });
    }
  });

  router.get("/favorites", requireAuth, noCache, (req, res) => {
    const { starred, library } = getStarredWithLibrary(req.user);
    res.json({ ...starred, library: toPublicLibrary(library) });
  });

  router.post("/favorites", requireAuth, requireUserAccount, noCache, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)
      : [];
    if (ids.length === 0 || ids.length > 100 || typeof req.body?.starred !== "boolean") {
      return res.status(400).json({
        error: "ids and starred are required",
      });
    }

    if (req.body.starred) {
      const libraryIds = ids.filter((id) => /^(artist|album|song):.+/.test(id));
      const validTargets = getLibraryFavoriteTargetKeys(libraryIds);
      if (libraryIds.some((id) => !validTargets.has(id))) {
        return res.status(400).json({ error: "Invalid favorite target" });
      }
    }

    const changed = req.body.starred
      ? starMany(req.user, ids, { skipLibraryValidation: true })
      : unstarMany(req.user, ids);
    if (!changed) {
      return res.status(400).json({ error: "Invalid favorite target" });
    }
    return res.json({ changedIds: ids, ...(req.body.starred ? {} : { removed: changed }) });
  });

  router.post("/favorites/restore", requireAuth, requireUserAccount, noCache, (req, res) => {
    const favorites = req.body?.favorites;
    if (!Array.isArray(favorites) || favorites.length > 500 || !restoreStars(req.user, favorites)) {
      return res.status(400).json({ error: "favorites must list removed favorites to restore" });
    }
    return res.json({ restoredIds: favorites.map((entry) => entry.id) });
  });
}

export { toPublicLibrary };

export type RequestLibraryRefreshResponse = {
  queued: true;
  jobId: ReturnType<typeof scheduleLibraryScan>;
  status: ReturnType<typeof getLibraryScanStatus>;
};

export type GetActiveLibraryRefreshResponse = {
  jobId: ReturnType<typeof getScheduledLibraryScanJobId>;
  status: ReturnType<typeof getLibraryScanStatus>;
};

export type GetLibraryRefreshStatusResponse = NonNullable<ReturnType<typeof getLibraryScanStatus>>;

export type FetchLibraryPageResponse = ReturnType<typeof toPublicLibraryPage>;

export type FetchLibraryFavoritesResponse = ReturnType<typeof getStarredWithLibrary>["starred"] & {
  library: ReturnType<typeof toPublicLibrary>;
};

export type UpdateLibraryFavoritesResponse = {
  changedIds: string[];
  removed?: Exclude<ReturnType<typeof unstarMany>, false>;
};

export type RestoreLibraryFavoritesResponse = { restoredIds: string[] };
