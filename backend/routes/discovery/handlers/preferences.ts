import { Hono } from "hono";
import * as v from "valibot";
import { dbOps } from "../../../db/helpers/index.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  getDiscoveryMode,
  getLocalDiscoveryPreferences,
} from "../../../services/discovery/index.ts";
import { asAppError } from "../../../../lib/errors.ts";

const preferencesInput = v.object({
  discoveryMode: v.nullish(v.string()),
  localDiscoveryIncludeRecommendations: v.nullish(v.boolean()),
  localDiscoveryIncludeTrending: v.nullish(v.boolean()),
});

export default new Hono<AppEnv>()
  .get("/preferences", requireAuth, (c) => {
    const localDiscoveryPreferences = getLocalDiscoveryPreferences();
    return c.json(
      {
        discoveryMode: getDiscoveryMode(),
        localDiscoveryIncludeRecommendations: localDiscoveryPreferences.includeRecommendations,
        localDiscoveryIncludeTrending: localDiscoveryPreferences.includeTrending,
      },
      200,
    );
  })
  .post("/preferences", requireAuth, validate("json", preferencesInput), (c) => {
    try {
      const updates = c.req.valid("json");
      const currentSettings = dbOps.getSettings();
      const nextSettings = {
        ...currentSettings,
        integrations: {
          ...(currentSettings.integrations || {}),
          lastfm: {
            ...(currentSettings.integrations?.lastfm || {}),
            discoveryMode:
              updates.discoveryMode === "safer" || updates.discoveryMode === "deeper"
                ? updates.discoveryMode
                : "balanced",
          },
          ticketmaster: {
            ...(currentSettings.integrations?.ticketmaster || {}),
            localDiscoveryIncludeRecommendations:
              updates.localDiscoveryIncludeRecommendations !== false,
            localDiscoveryIncludeTrending: updates.localDiscoveryIncludeTrending !== false,
          },
        },
      };
      dbOps.updateSettings(nextSettings);

      return c.json(
        {
          success: true,
          preferences: {
            discoveryMode: nextSettings.integrations?.lastfm?.discoveryMode || "balanced",
            localDiscoveryIncludeRecommendations:
              nextSettings.integrations?.ticketmaster?.localDiscoveryIncludeRecommendations !==
              false,
            localDiscoveryIncludeTrending:
              nextSettings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !== false,
          },
        },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to update preferences", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/preferences/reset", requireAuth, (c) => {
    const currentSettings = dbOps.getSettings();
    dbOps.updateSettings({
      ...currentSettings,
      integrations: {
        ...(currentSettings.integrations || {}),
        lastfm: {
          ...(currentSettings.integrations?.lastfm || {}),
          discoveryMode: "balanced",
        },
        ticketmaster: {
          ...(currentSettings.integrations?.ticketmaster || {}),
          localDiscoveryIncludeRecommendations: true,
          localDiscoveryIncludeTrending: true,
        },
      },
    });
    return c.json(
      {
        success: true,
        preferences: {
          discoveryMode: "balanced",
          localDiscoveryIncludeRecommendations: true,
          localDiscoveryIncludeTrending: true,
        },
      },
      200,
    );
  });
