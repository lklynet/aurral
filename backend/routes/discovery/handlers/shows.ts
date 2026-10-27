import { createHash } from "node:crypto";
import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getTicketmasterApiKey } from "../../../services/apiClients/index.ts";
import { getLibraryArtistNames } from "../../../services/libraryQueryService.ts";
import { getLocalDiscoveryPreferences } from "../../../services/discovery/index.ts";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.ts";
import { getNearbyShows } from "../../../services/nearbyShowsService.ts";
import { asAppError } from "../../../../lib/errors.ts";

type NearbyShowsOptions = Parameters<typeof getNearbyShows>[0];
type ArtistInput = NonNullable<NearbyShowsOptions["libraryArtists"]>[number];

const fingerprintArtists = (artists: ArtistInput[]) => {
  const names = [
    ...new Set(
      (Array.isArray(artists) ? artists : [])
        .map((artist) => String(artist?.artistName || artist?.name || "").trim())
        .filter(Boolean),
    ),
  ].sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
};

export const buildShowsResponseCacheKey = ({
  userId,
  libraryArtists,
  recommendedArtists,
  trendingArtists,
}: {
  userId: number;
  libraryArtists: ArtistInput[];
  recommendedArtists: ArtistInput[];
  trendingArtists: ArtistInput[];
}) =>
  JSON.stringify([
    userId,
    fingerprintArtists(libraryArtists),
    fingerprintArtists(recommendedArtists),
    fingerprintArtists(trendingArtists),
  ]);

const locationQuery = v.object({ zip: v.optional(v.string()), country: v.optional(v.string()) });

export default new Hono<AppEnv>().get(
  "/nearby-shows",
  requireAuth,
  validate("query", locationQuery),
  async (c) => {
    try {
      const apiKey = getTicketmasterApiKey();
      if (!apiKey) {
        c.header("Cache-Control", "no-cache, no-store, must-revalidate");
        return c.json({ configured: false, location: null, shows: [] }, 200);
      }

      const query = c.req.valid("query");
      const userId = c.var.user.id;
      const settings = dbOps.getSettings();
      const configuredRadius = Number(settings.integrations?.ticketmaster?.searchRadiusMiles);
      const localDiscoveryPreferences = getLocalDiscoveryPreferences();
      const radiusMiles = Number.isFinite(configuredRadius)
        ? Math.max(5, Math.min(250, Math.floor(configuredRadius)))
        : undefined;
      const { body: discovery } = getUserDiscovery(userId, 24);
      const recommendedArtists = localDiscoveryPreferences.includeRecommendations
        ? discovery.recommendations
        : [];
      const trendingArtists = localDiscoveryPreferences.includeTrending
        ? discovery.globalTop.slice(0, 18)
        : [];
      const libraryArtists = getLibraryArtistNames();
      const nearbyShows = await getNearbyShows({
        req: { ip: c.var.clientIp },
        zipCode: query.zip?.trim() ?? "",
        countryCode: query.country?.trim() ?? "",
        libraryArtists,
        recommendedArtists,
        trendingArtists,
        radiusMiles,
        responseCacheKey: buildShowsResponseCacheKey({
          userId,
          libraryArtists,
          recommendedArtists,
          trendingArtists,
        }),
      });

      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return c.json({ configured: true, ...nearbyShows }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to load nearby shows", message: asAppError(error)?.message },
        500,
      );
    }
  },
);
