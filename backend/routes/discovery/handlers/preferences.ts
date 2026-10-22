import type { Router } from "express";
import { requireAuth } from "../../../middleware/requirePermission.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import {
  getDiscoveryMode,
  getLocalDiscoveryPreferences,
} from "../../../services/discovery/index.ts";
import { asAppError } from "../../../../lib/errors.ts";

export function registerPreferences(router: Router) {
  router.get("/preferences", requireAuth, (req, res) => {
    const localDiscoveryPreferences = getLocalDiscoveryPreferences();
    res.json({
      discoveryMode: getDiscoveryMode(),
      localDiscoveryIncludeRecommendations: localDiscoveryPreferences.includeRecommendations,
      localDiscoveryIncludeTrending: localDiscoveryPreferences.includeTrending,
    });
  });

  router.post("/preferences", requireAuth, (req, res) => {
    try {
      const updates = req.body || {};
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

      res.json({
        success: true,
        preferences: {
          discoveryMode: nextSettings.integrations?.lastfm?.discoveryMode || "balanced",
          localDiscoveryIncludeRecommendations:
            nextSettings.integrations?.ticketmaster?.localDiscoveryIncludeRecommendations !== false,
          localDiscoveryIncludeTrending:
            nextSettings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !== false,
        },
      });
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to update preferences",
        message: failure?.message,
      });
    }
  });

  router.post("/preferences/reset", requireAuth, (req, res) => {
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
    res.json({
      success: true,
      preferences: {
        discoveryMode: "balanced",
        localDiscoveryIncludeRecommendations: true,
        localDiscoveryIncludeTrending: true,
      },
    });
  });
}
