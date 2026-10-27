import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import type { DiscoveryRecommendation } from "../../../services/discovery/recommendationPipeline.ts";
import { getDiscoveryStatus, getUserDiscovery } from "../../../services/discovery/userDiscovery.ts";

const toDiscoveryArtist = (artist: DiscoveryRecommendation) => ({
  id: artist.id ?? null,
  navigateTo: artist.navigateTo ?? null,
  name: artist.name,
  type: artist.type || "Artist",
  image: artist.image || null,
  tags: artist.tags || [],
  matchedTags: artist.matchedTags || [],
  sourceArtist: artist.sourceArtist || null,
  sourceArtists: artist.sourceArtists || [],
  sourceType: artist.sourceType || null,
  supportingSeeds: (artist.supportingSeeds || []).map((seed) => ({ artistName: seed?.artistName })),
  discoveryTier: artist.discoveryTier || null,
  score: artist.score ?? null,
  scoreTotal: artist.scoreTotal ?? null,
  matchPercent: artist.matchPercent ?? null,
  popularityLabel: artist.popularityLabel || null,
  popularityRank: artist.popularityRank || null,
  listeners: artist.listeners || 0,
  playcount: artist.playcount || 0,
});

const pageQuery = v.object({ limit: v.optional(v.string()), offset: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .get("/status", requireAuth, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(getDiscoveryStatus(c.var.user.id), 200);
  })
  .get("/", requireAuth, validate("query", pageQuery), (c) => {
    const { limit, offset } = c.req.valid("query");
    const { body } = limit?.trim()
      ? getUserDiscovery(
          c.var.user.id,
          Math.max(1, Math.min(200, parseInt(limit, 10) || 0)),
          Math.max(0, parseInt(offset ?? "", 10) || 0),
        )
      : getUserDiscovery(c.var.user.id, 0, 0);

    c.header("Cache-Control", "private, no-cache");
    return c.json(
      {
        ...body,
        recommendations: body.recommendations.map(toDiscoveryArtist),
        globalTop: body.globalTop.map(toDiscoveryArtist),
      },
      200,
    );
  });
