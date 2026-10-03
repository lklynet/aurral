import { requireAuth } from "../../../middleware/requirePermission.js";
import {
  getDiscoveryStatus,
  getUserDiscovery,
} from "../../../services/discovery/userDiscovery.js";

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
  matchPercent: artist.matchPercent ?? null,
  popularityLabel: artist.popularityLabel || null,
  popularityRank: artist.popularityRank || null,
  listeners: artist.listeners || 0,
  playcount: artist.playcount || 0,
});

export function registerMain(router) {
  router.get("/status", requireAuth, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(getDiscoveryStatus(req.user.id));
  });

  router.get("/", requireAuth, async (req, res) => {
    const hasExplicitLimit = typeof req.query.limit === "string" && req.query.limit.trim() !== "";
    const limit = hasExplicitLimit
      ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 0))
      : 0;
    const offset = hasExplicitLimit
      ? Math.max(0, parseInt(req.query.offset, 10) || 0)
      : 0;
    const { body } = await getUserDiscovery(req.user.id, limit, offset);

    res.set("Cache-Control", "private, no-cache");
    res.json({
      ...body,
      recommendations: body.recommendations.map(toDiscoveryArtist),
      globalTop: body.globalTop.map(toDiscoveryArtist),
    });
  });
}
