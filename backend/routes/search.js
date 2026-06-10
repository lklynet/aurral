import express from "express";
import { noCache } from "../middleware/cache.js";
import {
  searchAlbums,
  searchArtists,
  searchTags,
} from "../services/searchService.js";

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

router.get("/artists", noCache, async (req, res) => {
  try {
    const { query, limit = 24, offset = 0 } = req.query;
    if (!String(query || "").trim()) {
      return res.status(400).json({ error: "Query parameter is required" });
    }
    const result = await searchArtists(query, limit, offset);
    return res.json({
      artists: result.items.map((artist) => ({
        id: artist.id,
        name: artist.name,
        "sort-name": artist.sortName,
        image: artist.imageUrl,
        imageUrl: artist.imageUrl,
        listeners: null,
      })),
      count: result.count,
      offset: result.offset,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to search artists",
      message: error.message,
    });
  }
});

export default router;
