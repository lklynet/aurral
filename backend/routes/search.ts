import express from "express";
import { noCache } from "../middleware/cache.ts";
import { requireAuth } from "../middleware/requirePermission.ts";
import { searchAlbums, searchArtists, searchTags } from "../services/searchService.ts";
import { resolveStreamingLink } from "../services/streamingLinks.ts";
import { logger, safeLogDiagnostic } from "../services/logger.ts";
import { searchLibrary, searchUnified } from "../services/unifiedSearchService.ts";
import { asAppError } from "../../lib/errors.ts";

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
    const failure = asAppError(error);
    res.status(500).json({
      error: "Failed to search",
      message: failure?.message,
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
    const failure = asAppError(error);
    res.status(500).json({
      error: "Failed to search library",
      message: failure?.message,
    });
  }
});

router.get("/link", requireAuth, noCache, async (req, res) => {
  try {
    return res.json(await resolveStreamingLink(req.query.url));
  } catch (error) {
    const failure = asAppError(error);
    const statusCode = failure?.statusCode;
    const status =
      typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : 500;
    if (status >= 500) {
      logger.warn("search", "Failed to resolve link", { reason: safeLogDiagnostic(error) });
    }
    return res.status(status).json({
      error: "Failed to resolve link",
      message: failure?.message || "Unknown error",
      ...(failure?.code ? { code: failure.code } : {}),
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
    const failure = asAppError(error);
    if (controller.signal.aborted) return;
    res.status(500).json({
      error: "Failed to run unified search",
      message: failure?.message,
    });
  }
});

export default router;
