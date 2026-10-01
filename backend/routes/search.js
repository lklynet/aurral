import express from "express";
import { noCache } from "../middleware/cache.js";
import { searchAlbums, searchArtists, searchTags } from "../services/searchService.js";
import { searchLibrary, searchUnified } from "../services/unifiedSearchService.js";

const router = express.Router();

router.get("/", noCache, async (req, res) => {
  try {
    const {
      q,
      scope = "artist",
      limit = 24,
      offset = 0,
      releaseTypes = "",
      sort = "relevance",
    } = req.query;

    if (!String(q || "").trim()) {
      return res.status(400).json({ error: "q parameter is required" });
    }

    if (scope === "album") {
      return res.json(await searchAlbums(q, limit, offset, releaseTypes, sort));
    }

    if (scope === "tag") {
      return res.json(await searchTags(q, limit, offset));
    }

    return res.json(await searchArtists(q, limit, offset));
  } catch (error) {
    res.status(500).json({
      error: "Failed to search",
      message: error.message,
    });
  }
});

router.get("/library", noCache, (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!String(q || "").trim()) {
      return res.status(400).json({ error: "q parameter is required" });
    }
    return res.json(searchLibrary(q, { limit, user: req.user || null }));
  } catch (error) {
    res.status(500).json({
      error: "Failed to search library",
      message: error.message,
    });
  }
});

router.get("/unified", noCache, async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const { q, mode = "suggest", limit } = req.query;
    if (!String(q || "").trim()) {
      return res.status(400).json({ error: "q parameter is required" });
    }
    return res.json(
      await searchUnified(q, {
        mode,
        limit,
        user: req.user || null,
        signal: controller.signal,
      }),
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    res.status(500).json({
      error: "Failed to run unified search",
      message: error.message,
    });
  }
});

export default router;
