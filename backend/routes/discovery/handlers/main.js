import { requireAuth } from "../../../middleware/requirePermission.js";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.js";

const CACHE_HEADERS = {
  fresh: "private, max-age=120, stale-while-revalidate=300",
  updating: "no-cache, no-store, must-revalidate",
  empty: "private, max-age=30, stale-while-revalidate=120",
};

const toDiscoveryArtist = (artist) => ({
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
  popularityLabel: artist.popularityLabel || null,
  popularityRank: artist.popularityRank || null,
  listeners: artist.listeners || 0,
  playcount: artist.playcount || 0,
});

export function registerMain(router) {
  router.get("/", requireAuth, async (req, res) => {
    const hasExplicitLimit = typeof req.query.limit === "string" && req.query.limit.trim() !== "";
    const limit = hasExplicitLimit
      ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 0))
      : 0;
    const offset = hasExplicitLimit
      ? Math.max(0, parseInt(req.query.offset, 10) || 0)
      : 0;
    const { body, cacheStrategy } = await getUserDiscovery(req.user.id, limit, offset);

    res.set("Cache-Control", CACHE_HEADERS[cacheStrategy]);
    res.json({
      ...body,
      recommendations: body.recommendations.map(toDiscoveryArtist),
      globalTop: body.globalTop.map(toDiscoveryArtist),
    });
  });
}
