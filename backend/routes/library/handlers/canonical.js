import { noCache } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { getCanonicalLibrary } from "../../../services/libraryQueryService.js";
import { getStarred, starMany, unstarMany } from "../../../services/subsonicLibraryService.js";

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

function toPublicLibrary(library) {
  return stripFilesystemPaths({
    artists: library.artists,
    albums: library.albums,
    tracks: library.tracks,
  });
}

export function registerCanonical(router) {
  router.get("/canonical", noCache, (req, res) => {
    try {
      const library = getCanonicalLibrary({
        source: req.query.source,
        availableOnly: req.query.availableOnly === "true",
      });
      return res.json(toPublicLibrary(library));
    } catch (error) {
      if (error.message.startsWith("Unsupported library source:")) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({
        error: "Failed to query canonical library",
        message: error.message,
      });
    }
  });

  router.get("/favorites", requireAuth, noCache, (req, res) => {
    res.json(getStarred(req.user));
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

    const changed = req.body.starred ? starMany(req.user, ids) : unstarMany(req.user, ids);
    if (!changed) {
      return res.status(400).json({ error: "Invalid favorite target" });
    }
    return res.json(getStarred(req.user));
  });
}

export { toPublicLibrary };
