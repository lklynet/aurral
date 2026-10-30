import { Hono } from "hono";
import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import { validateExternalUrl } from "../../middleware/urlValidator.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import {
  getPlaybackDestinationSettings,
  testPlaybackDestination,
} from "../../services/playback/playbackDestinationSettings.ts";
import { logger } from "../../services/logger.ts";
import { asAppError } from "../../../lib/errors.ts";

function getPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

function describePlexError(error: unknown) {
  const failure = asAppError(error);
  const status = failure?.response?.status;
  const data = failure?.response?.data;
  if (typeof data === "string" && data.trim() && !/^\s*<(!doctype|html)/i.test(data)) {
    return data.length > 300 ? `${data.slice(0, 300)}…` : data;
  }
  if (status) return `Plex returned an error (HTTP ${status}).`;
  return failure?.message || "Unknown error";
}

type PlexSection = { key: string; title: string; type: string };

const plexAuthStart = v.object({ forwardUrl: v.optional(v.string()) });
const plexAuthCheck = v.object({
  pinId: v.optional(v.union([v.number(), v.string()])),
  code: v.optional(v.string()),
});
const plexToken = v.object({ token: v.optional(v.string()) });
const plexServer = v.object({ url: v.optional(v.string()), token: v.optional(v.string()) });
const destinationConfig = v.record(v.string(), v.unknown());

export default new Hono<AppEnv>()
  .basePath("/settings")
  .post("/plex/auth/pin", requireAuth, requireAdmin, validate("json", plexAuthStart), async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const settings = dbOps.getSettings();
      const plex = settings.integrations?.plex || {};
      let clientId = plex.clientId;
      if (!clientId) {
        clientId = PlexClient.generateClientId();
        dbOps.updateSettings({
          integrations: {
            ...settings.integrations,
            plex: { ...plex, clientId },
          },
        });
      }
      const { id, code } = await PlexClient.generatePin(clientId);
      return c.json(
        {
          pinId: id,
          code,
          clientId,
          authUrl: PlexClient.buildAuthUrl(clientId, code, c.req.valid("json").forwardUrl),
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("settings", "Plex PIN generation failed:", failure?.message);
      return c.json(
        { error: "Failed to start Plex authentication", message: failure?.message },
        500,
      );
    }
  })
  .post(
    "/plex/auth/check",
    requireAuth,
    requireAdmin,
    validate("json", plexAuthCheck),
    async (c) => {
      try {
        const { PlexClient } = await import("../../services/plex.ts");
        const { pinId, code } = c.req.valid("json");
        if (!pinId || !code) return c.json({ error: "pinId and code are required" }, 400);
        const clientId = getPlexConfig().clientId;
        if (!clientId) return c.json({ error: "Plex client not initialized" }, 400);
        const token: string | null = await PlexClient.checkPin(pinId, code, clientId);
        if (!token) return c.json({ pending: true }, 200);
        let plexUsername: string | null = null;
        try {
          const identity = await PlexClient.validateToken(token, clientId);
          plexUsername = identity?.username || identity?.title || null;
        } catch {}
        return c.json({ token, plexUsername }, 200);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("settings", "Plex PIN check failed:", failure?.message);
        return c.json(
          { error: "Failed to check Plex authentication", message: failure?.message },
          500,
        );
      }
    },
  )
  .post("/plex/resources", requireAuth, requireAdmin, validate("json", plexToken), async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const stored = getPlexConfig();
      const token = c.req.valid("json").token || stored.token;
      const clientId = stored.clientId;
      if (!token || !clientId) return c.json({ error: "Plex authentication required" }, 400);
      const { servers, total } = await PlexClient.getResources(token, clientId);
      return c.json({ servers, total }, 200);
    } catch (error) {
      const failure = asAppError(error);
      const status = failure?.response?.status;
      logger.error(
        "settings",
        "Plex resources failed:",
        status ? `${status} ${JSON.stringify(failure?.response?.data)}` : failure?.message,
      );
      return c.json(
        {
          error: "Failed to list Plex servers",
          message:
            status === 401
              ? "Plex rejected the token (401). Reconnect your Plex account."
              : failure?.message,
        },
        status === 401 ? 401 : 500,
      );
    }
  })
  .post("/plex/test", requireAuth, requireAdmin, validate("json", plexServer), async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const stored = getPlexConfig();
      const input = c.req.valid("json");
      const url = (input.url || stored.url || "").trim().replace(/\/+$/, "");
      const token = input.token || stored.token;
      if (!url || !token) return c.json({ error: "Server URL and token are required" }, 400);
      const urlValidation = validateExternalUrl(url);
      if (!urlValidation.valid) return c.json({ error: urlValidation.error }, 400);
      const client = new PlexClient(urlValidation.url, token, stored.clientId);
      const identity = await client.ping();
      return c.json(
        {
          success: true,
          message: "Connection successful",
          machineIdentifier: identity.machineIdentifier,
          version: identity.version,
        },
        200,
      );
    } catch (error) {
      return c.json({ error: "Connection failed", message: describePlexError(error) }, 400);
    }
  })
  .get("/plex/libraries/:sectionId/access-check", requireAuth, requireAdmin, async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const { pathIsReadable } = await import("../../services/lidarrLibraryAccessTest.ts");
      const { getPathMappings } = await import("../../services/pathMappings.ts");
      const stored = getPlexConfig();
      if (!stored.url || !stored.token) return c.json({ error: "Connect Plex first" }, 400);
      const sectionId = c.req.param("sectionId").trim();
      if (!sectionId) return c.json({ error: "sectionId is required" }, 400);
      const client = new PlexClient(stored.url, stored.token, stored.clientId);
      const sample = await client.getSampleTrack(sectionId);
      if (!sample?.files?.length) {
        return c.json({ checked: false, reason: "No tracks in this library to check." }, 200);
      }
      const reportedPath = sample.files[0];
      const readablePath = await pathIsReadable(reportedPath, getPathMappings("plex"));
      return c.json({ checked: true, accessible: Boolean(readablePath), reportedPath }, 200);
    } catch (error) {
      logger.error("settings", "Plex library access check failed:", asAppError(error)?.message);
      return c.json(
        { error: "Failed to check library access", message: describePlexError(error) },
        500,
      );
    }
  })
  .get("/plex/libraries", requireAuth, requireAdmin, async (c) => {
    try {
      const { PlexClient, MUSIC_SECTION_TYPE } = await import("../../services/plex.ts");
      const stored = getPlexConfig();
      if (!stored.url || !stored.token) return c.json({ error: "Connect Plex first" }, 400);
      const client = new PlexClient(stored.url, stored.token, stored.clientId);
      const libraries: PlexSection[] = await client.getLibraries();
      return c.json(
        {
          libraries: libraries
            .filter((lib) => lib.type === MUSIC_SECTION_TYPE && lib.title !== "Aurral")
            .map((lib) => ({ key: lib.key, title: lib.title })),
        },
        200,
      );
    } catch (error) {
      logger.error("settings", "Plex library listing failed:", asAppError(error)?.message);
      return c.json(
        { error: "Failed to list Plex libraries", message: describePlexError(error) },
        500,
      );
    }
  })
  .post("/plex/sync", requireAuth, requireAdmin, async (c) => {
    try {
      const plex = getPlexConfig();
      if (!plex.url || !plex.token) {
        return c.json(
          {
            error: "Plex not configured",
            message: "Connect Plex and save settings before syncing",
          },
          400,
        );
      }
      const { playlistManager } = await import("../../services/playlists/playlistManager.ts");
      playlistManager.updateConfig();
      const result = await playlistManager.syncPlexNow();
      return c.json({ success: true, ...result }, 200);
    } catch (error) {
      logger.error("settings", "Plex sync failed:", asAppError(error)?.message);
      return c.json({ error: "Plex sync failed", message: describePlexError(error) }, 500);
    }
  })
  .get("/playback", requireAuth, requireAdmin, (c) =>
    c.json({ destinations: getPlaybackDestinationSettings() }, 200),
  )
  .post(
    "/playback/:key/test",
    requireAuth,
    requireAdmin,
    validate("json", destinationConfig),
    async (c) => {
      try {
        const result = await testPlaybackDestination(c.req.param("key"), c.req.valid("json"));
        if (!result.ok) return c.json({ error: result.error.message, ...result.error }, 400);
        return c.json({ success: true }, 200);
      } catch (error) {
        return c.json({ error: "Connection failed", message: asAppError(error)?.message }, 400);
      }
    },
  );
