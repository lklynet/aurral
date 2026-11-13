import { Hono } from "hono";
import * as v from "valibot";
import { dbOps } from "../../../db/helpers/index.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  DISCOVERY_MODES,
  getDiscoveryMode,
  getLocalDiscoveryPreferences,
  setDiscoveryMode,
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
        discoveryMode: getDiscoveryMode(c.var.user.id),
        localDiscoveryIncludeRecommendations: localDiscoveryPreferences.includeRecommendations,
        localDiscoveryIncludeTrending: localDiscoveryPreferences.includeTrending,
      },
      200,
    );
  })
  .post("/preferences", requireAuth, validate("json", preferencesInput), (c) => {
    try {
      const updates = c.req.valid("json");
      const userId = c.var.user.id;
      if (updates.discoveryMode != null) {
        setDiscoveryMode(
          userId,
          DISCOVERY_MODES.find((mode) => mode === updates.discoveryMode) ?? "balanced",
        );
      }
      const local = {
        localDiscoveryIncludeRecommendations: updates.localDiscoveryIncludeRecommendations,
        localDiscoveryIncludeTrending: updates.localDiscoveryIncludeTrending,
      };
      if (Object.values(local).some((value) => value != null)) {
        const currentSettings = dbOps.getSettings();
        const ticketmaster = currentSettings.integrations?.ticketmaster || {};
        dbOps.updateSettings({
          integrations: {
            ...currentSettings.integrations,
            ticketmaster: {
              ...ticketmaster,
              localDiscoveryIncludeRecommendations:
                local.localDiscoveryIncludeRecommendations ??
                ticketmaster.localDiscoveryIncludeRecommendations,
              localDiscoveryIncludeTrending:
                local.localDiscoveryIncludeTrending ?? ticketmaster.localDiscoveryIncludeTrending,
            },
          },
        });
      }
      const localDiscoveryPreferences = getLocalDiscoveryPreferences();
      return c.json(
        {
          success: true,
          preferences: {
            discoveryMode: getDiscoveryMode(userId),
            localDiscoveryIncludeRecommendations: localDiscoveryPreferences.includeRecommendations,
            localDiscoveryIncludeTrending: localDiscoveryPreferences.includeTrending,
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
    setDiscoveryMode(c.var.user.id, "balanced");
    const currentSettings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...(currentSettings.integrations || {}),
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
