import { noCache } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { dbOps } from "../../../db/helpers/index.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import {
  getCanonicalFavoriteTargetKeys,
  getCanonicalLibraryPage,
} from "../../../services/libraryQueryService.js";
import {
  getStarredIdentityKeys,
  getStarredWithLibrary,
  starMany,
  unstarMany,
} from "../../../services/subsonicLibraryService.js";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
  scheduleLibraryScan,
} from "../../../services/libraryScanWorker.js";

const isFilesystemPathKey = (key) => key.toLowerCase().endsWith("path");

export function stripFilesystemPaths(value) {
  if (Array.isArray(value)) return value.map(stripFilesystemPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isFilesystemPathKey(key))
      .map(([key, entry]) => [key, stripFilesystemPaths(entry)]),
  );
}

// Resolves the effective availableOnly flag for a canonical library read.
// An explicit query param always wins so detail/track views can force a value;
// otherwise the Lidarr "show available music only" setting decides, defaulting
// to on so the Library shows owned music rather than the full discography.
export function resolveCanonicalAvailableOnly(queryValue, settings) {
  if (queryValue === "true") return true;
  if (queryValue === "false") return false;
  return settings?.integrations?.lidarr?.availableOnly !== false;
}

function getAlbumCoverUrl(album) {
  const image = (Array.isArray(album?.metadata?.images) ? album.metadata.images : []).find(
    (entry) => /^https?:\/\//i.test(entry?.remoteUrl || entry?.imageUrl || entry?.url || ""),
  );
  const source = image?.remoteUrl || image?.imageUrl || image?.url;
  return /^https?:\/\//i.test(source || "") ? buildImageProxyUrl(source) : null;
}

export const publicLibraryJsonReplacer = (key, value) =>
  isFilesystemPathKey(key) ? undefined : value;

const publicEntity = (kind, entity, favoriteKeys) => favoriteKeys
  ? { ...entity, userFavorite: favoriteKeys.has(`${kind}:${entity.identityKey}`) }
  : entity;

const publicAlbum = (album, favoriteKeys) => ({
  ...album,
  coverUrl: album.coverUrl || getAlbumCoverUrl(album),
  ...(favoriteKeys
    ? { userFavorite: favoriteKeys.has(`album:${album.identityKey}`) }
    : {}),
});

export function buildPublicLibrary(library, favoriteKeys = null) {
  return {
    artists: library.artists.map((artist) => publicEntity("artist", artist, favoriteKeys)),
    albums: library.albums.map((album) => publicAlbum(album, favoriteKeys)),
    tracks: library.tracks.map((track) => publicEntity("song", track, favoriteKeys)),
  };
}

function toPublicLibrary(library, favoriteKeys = null) {
  return stripFilesystemPaths(buildPublicLibrary(library, favoriteKeys));
}

export function toPublicLibraryPage(page, favoriteKeys = null) {
  const collections = toPublicLibrary(page, favoriteKeys);
  const items = page.kind === "artists"
    ? collections.artists
    : page.kind === "albums"
      ? collections.albums
      : page.kind === "tracks"
        ? collections.tracks
        : stripFilesystemPaths(page.items);
  return {
    ...stripFilesystemPaths(page),
    ...collections,
    items,
  };
}

export function registerCanonical(router) {
  router.post("/refresh", requireAuth, (_req, res) => {
    const jobId = scheduleLibraryScan({ force: true });
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

  router.get("/refresh/:jobId", requireAuth, noCache, (req, res) => {
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
      const requestedPageSize = typeof req.query.pageSize === "string"
        ? Number(req.query.pageSize)
        : NaN;
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
      return res.json(toPublicLibraryPage(getCanonicalLibraryPage({
        source: req.query.source,
        availableOnly: resolveCanonicalAvailableOnly(
          req.query.availableOnly,
          dbOps.getSettings(),
        ),
        kind,
        page: req.query.page,
        pageSize: requestedPageSize,
        query: req.query.query,
        genre: req.query.genre,
        sort: req.query.sort,
        direction: req.query.direction,
        artistId: req.query.artistId,
        albumId: req.query.albumId,
      }), favoriteKeys));
    } catch (error) {
      if (
        error.message.startsWith("Unsupported library source:") ||
        error.message.startsWith("Unsupported library page kind:")
      ) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({
        error: "Failed to query canonical library",
        message: error.message,
      });
    }
  });

  router.get("/favorites", requireAuth, noCache, (req, res) => {
    const { starred, library } = getStarredWithLibrary(req.user);
    res.json({ ...starred, library: toPublicLibrary(library) });
  });

  router.post("/favorites", requireAuth, noCache, (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (ids.length === 0 || ids.length > 100 || typeof req.body?.starred !== "boolean") {
      return res.status(400).json({
        error: "ids and starred are required",
      });
    }

    if (req.body.starred) {
      const canonicalIds = ids.filter((id) => /^(artist|album|song):.+/.test(id));
      const validTargets = getCanonicalFavoriteTargetKeys(canonicalIds);
      if (canonicalIds.some((id) => !validTargets.has(id))) {
        return res.status(400).json({ error: "Invalid favorite target" });
      }
    }

    const changed = req.body.starred
      ? starMany(req.user, ids, { skipCanonicalValidation: true })
      : unstarMany(req.user, ids);
    if (!changed) {
      return res.status(400).json({ error: "Invalid favorite target" });
    }
    return res.json({ changedIds: ids });
  });
}

export { toPublicLibrary };
