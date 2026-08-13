import { noCache } from "../../../middleware/cache.js";
import { getCanonicalLibrary } from "../../../services/libraryQueryService.js";

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
}

export { toPublicLibrary };
