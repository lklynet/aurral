import { dbOps } from "../../../db/helpers/index.js";
import { validateExternalUrl } from "../../../middleware/urlValidator.js";
import { logger } from "../../../services/logger.js";

function getPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

function describePlexError(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  if (typeof data === "string" && data.trim() && !/^\s*<(!doctype|html)/i.test(data)) {
    return data.length > 300 ? `${data.slice(0, 300)}…` : data;
  }
  if (status) return `Plex returned an error (HTTP ${status}).`;
  return error?.message || "Unknown error";
}

export function registerPlex(router) {
  router.post("/plex/auth/pin", async (req, res) => {
    try {
      const { PlexClient } = await import("../../../services/plex.js");
      const settings = dbOps.getSettings();
      const plex = settings.integrations?.plex || {};
      let clientId = plex.clientId;
      if (!clientId) {
        clientId = PlexClient.generateClientId();
        dbOps.updateSettings({
          ...settings,
          integrations: {
            ...settings.integrations,
            plex: { ...plex, clientId },
          },
        });
      }
      const { id, code } = await PlexClient.generatePin(clientId);
      const forwardUrl = req.body?.forwardUrl;
      res.json({
        pinId: id,
        code,
        clientId,
        authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl),
      });
    } catch (error) {
      logger.error("settings", "Plex PIN generation failed:", error.message);
      res.status(500).json({
        error: "Failed to start Plex authentication",
        message: error.message,
      });
    }
  });

  router.post("/plex/auth/check", async (req, res) => {
    try {
      const { PlexClient } = await import("../../../services/plex.js");
      const { pinId, code } = req.body || {};
      if (!pinId || !code) {
        return res.status(400).json({ error: "pinId and code are required" });
      }
      const clientId = getPlexConfig().clientId;
      if (!clientId) {
        return res.status(400).json({ error: "Plex client not initialized" });
      }
      const token = await PlexClient.checkPin(pinId, code, clientId);
      if (!token) return res.json({ pending: true });
      let plexUsername = null;
      try {
        const identity = await PlexClient.validateToken(token, clientId);
        plexUsername = identity?.username || identity?.title || null;
      } catch {}
      res.json({ token, plexUsername });
    } catch (error) {
      logger.error("settings", "Plex PIN check failed:", error.message);
      res.status(500).json({
        error: "Failed to check Plex authentication",
        message: error.message,
      });
    }
  });

  router.post("/plex/resources", async (req, res) => {
    try {
      const { PlexClient } = await import("../../../services/plex.js");
      const stored = getPlexConfig();
      const token = req.body?.token || stored.token;
      const clientId = stored.clientId;
      if (!token || !clientId) {
        return res.status(400).json({ error: "Plex authentication required" });
      }
      const { servers, total } = await PlexClient.getResources(token, clientId);
      res.json({ servers, total });
    } catch (error) {
      const status = error.response?.status;
      logger.error(
        "settings",
        "Plex resources failed:",
        status ? `${status} ${JSON.stringify(error.response?.data)}` : error.message,
      );
      res.status(status === 401 ? 401 : 500).json({
        error: "Failed to list Plex servers",
        message:
          status === 401
            ? "Plex rejected the token (401). Reconnect your Plex account."
            : error.message,
      });
    }
  });

  router.post("/plex/test", async (req, res) => {
    try {
      const { PlexClient } = await import("../../../services/plex.js");
      const stored = getPlexConfig();
      let url = (req.body?.url || stored.url || "").trim().replace(/\/+$/, "");
      const token = req.body?.token || stored.token;
      const clientId = stored.clientId;
      if (!url || !token) {
        return res.status(400).json({ error: "Server URL and token are required" });
      }
      const urlValidation = validateExternalUrl(url);
      if (!urlValidation.valid) {
        return res.status(400).json({ error: urlValidation.error });
      }
      url = urlValidation.url;
      const client = new PlexClient(url, token, clientId);
      const identity = await client.ping();
      res.json({
        success: true,
        message: "Connection successful",
        machineIdentifier: identity.machineIdentifier,
        version: identity.version,
      });
    } catch (error) {
      res.status(400).json({
        error: "Connection failed",
        message: describePlexError(error),
      });
    }
  });

  router.get("/plex/libraries/:sectionId/access-check", async (req, res) => {
    try {
      const { PlexClient } = await import("../../../services/plex.js");
      const { pathIsReadable } = await import("../../../services/lidarrLibraryAccessTest.js");
      const { getPathMappings } = await import("../../../services/pathMappings.js");
      const stored = getPlexConfig();
      if (!stored.url || !stored.token) {
        return res.status(400).json({ error: "Connect Plex first" });
      }
      const sectionId = String(req.params.sectionId || "").trim();
      if (!sectionId) {
        return res.status(400).json({ error: "sectionId is required" });
      }
      const client = new PlexClient(stored.url, stored.token, stored.clientId);
      const sample = await client.getSampleTrack(sectionId);
      if (!sample?.files?.length) {
        return res.json({
          checked: false,
          reason: "This library doesn't have any tracks yet to check against.",
        });
      }
      const reportedPath = sample.files[0];
      const readablePath = await pathIsReadable(reportedPath, getPathMappings("plex"));
      res.json({
        checked: true,
        accessible: Boolean(readablePath),
        reportedPath,
      });
    } catch (error) {
      logger.error("settings", "Plex library access check failed:", error.message);
      res.status(500).json({
        error: "Failed to check library access",
        message: describePlexError(error),
      });
    }
  });

  router.get("/plex/libraries", async (req, res) => {
    try {
      const { PlexClient, MUSIC_SECTION_TYPE } = await import("../../../services/plex.js");
      const stored = getPlexConfig();
      if (!stored.url || !stored.token) {
        return res.status(400).json({ error: "Connect Plex first" });
      }
      const client = new PlexClient(stored.url, stored.token, stored.clientId);
      const libraries = await client.getLibraries();
      const musicLibraries = libraries.filter(
        (lib) => lib.type === MUSIC_SECTION_TYPE && lib.title !== "Aurral",
      );
      res.json({
        libraries: musicLibraries.map((lib) => ({ key: lib.key, title: lib.title })),
      });
    } catch (error) {
      logger.error("settings", "Plex library listing failed:", error.message);
      res.status(500).json({
        error: "Failed to list Plex libraries",
        message: describePlexError(error),
      });
    }
  });

  router.post("/plex/sync", async (req, res) => {
    try {
      const plex = getPlexConfig();
      if (!plex.url || !plex.token) {
        return res.status(400).json({
          error: "Plex not configured",
          message: "Connect Plex and save settings before syncing",
        });
      }
      const { playlistManager } = await import(
        "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js"
      );
      playlistManager.updateConfig(false);
      const result = await playlistManager.syncPlexNow();
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error("settings", "Plex sync failed:", error.message);
      res.status(500).json({
        error: "Plex sync failed",
        message: describePlexError(error),
      });
    }
  });
}
