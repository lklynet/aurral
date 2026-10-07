import express from "express";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { searchAlbums, searchArtists, searchTags } from "../services/searchService.js";
import { resolveStreamingLink } from "../services/streamingLinks.js";
import { logger, safeLogDiagnostic } from "../services/logger.js";
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

router.get("/link", requireAuth, noCache, async (req, res) => {
  try {
    return res.json(await resolveStreamingLink(req.query.url));
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) {
      logger.warn("search", "Failed to resolve link", { reason: safeLogDiagnostic(error) });
    }
    return res.status(status).json({
      error: "Failed to resolve link",
      message: error?.message || "Unknown error",
      ...(error?.code ? { code: error.code } : {}),
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
