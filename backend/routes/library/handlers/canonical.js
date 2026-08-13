import { noCache } from "../../../middleware/cache.js";
import { getCanonicalLibrary } from "../../../services/libraryQueryService.js";

function toPublicLibrary(library) {
  return {
    artists: library.artists,
    albums: library.albums,
    tracks: library.tracks.map((track) => ({
      ...track,
      files: track.files.map(({ path: _path, ...file }) => file),
    })),
  };
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
