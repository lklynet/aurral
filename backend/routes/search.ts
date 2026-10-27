import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { searchAlbums, searchArtists, searchTags } from "../services/searchService.ts";
import { resolveStreamingLink } from "../services/streamingLinks.ts";
import { logger, safeLogDiagnostic } from "../services/logger.ts";
import { searchLibrary, searchUnified } from "../services/unifiedSearchService.ts";
import { asAppError } from "../../lib/errors.ts";
import { errorStatus } from "./shared/errorStatus.ts";

const text = v.optional(v.string());
const missingQuery = { error: "q parameter is required" };

const catalogQuery = v.object({
  q: text,
  scope: text,
  limit: text,
  offset: text,
  releaseTypes: text,
  sort: text,
});

export default new Hono<AppEnv>()
  .basePath("/search")
  .get("/", noCache, validate("query", catalogQuery), async (c) => {
    try {
      const {
        q = "",
        scope = "artist",
        limit,
        offset,
        releaseTypes = "",
        sort = "relevance",
      } = c.req.valid("query");
      if (!q.trim()) return c.json(missingQuery, 400);
      if (scope === "album") {
        return c.json(await searchAlbums(q, limit, offset, releaseTypes, sort), 200);
      }
      if (scope === "tag") return c.json(await searchTags(q, limit, offset), 200);
      return c.json(await searchArtists(q, limit, offset), 200);
    } catch (error) {
      return c.json({ error: "Failed to search", message: asAppError(error)?.message }, 500);
    }
  })
  .get("/library", noCache, validate("query", v.object({ q: text, limit: text })), (c) => {
    try {
      const { q = "", limit } = c.req.valid("query");
      if (!q.trim()) return c.json(missingQuery, 400);
      return c.json(searchLibrary(q, { limit, user: c.var.user || null }), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to search library", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/link", requireAuth, noCache, validate("query", v.object({ url: text })), async (c) => {
    try {
      return c.json(await resolveStreamingLink(c.req.valid("query").url), 200);
    } catch (error) {
      const failure = asAppError(error);
      const status = errorStatus(failure);
      if (status >= 500) {
        logger.warn("search", "Failed to resolve link", { reason: safeLogDiagnostic(error) });
      }
      return c.json(
        {
          error: "Failed to resolve link",
          message: failure?.message || "Unknown error",
          ...(failure?.code ? { code: failure.code } : {}),
        },
        status,
      );
    }
  })
  .get(
    "/unified",
    noCache,
    validate("query", v.object({ q: text, mode: text, limit: text })),
    async (c) => {
      try {
        const { q = "", mode = "suggest", limit } = c.req.valid("query");
        if (!q.trim()) return c.json(missingQuery, 400);
        return c.json(
          await searchUnified(q, {
            mode,
            limit,
            user: c.var.user || null,
            signal: c.req.raw.signal,
          }),
          200,
        );
      } catch (error) {
        return c.json(
          { error: "Failed to run unified search", message: asAppError(error)?.message },
          500,
        );
      }
    },
  );
