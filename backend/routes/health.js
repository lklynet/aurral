import express from "express";
import { readFileSync } from "fs";
import {
  getLastfmApiKey,
  getTicketmasterApiKey,
} from "../services/apiClients.js";
import {
  resolveRequestUser,
  getAuthUser,
  isAuthRequiredByConfig,
  issueStreamToken,
} from "../middleware/auth.js";
import { getDiscoveryCache } from "../services/discoveryService.js";
import { getCachedArtistCount } from "../services/libraryManager.js";
import { lidarrClient } from "../services/lidarrClient.js";
import { dbOps } from "../config/db-helpers.js";
import { websocketService } from "../services/websocketService.js";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";

let rootPackageVersion = "unknown";
try {
  const raw = readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf-8",
  );
  rootPackageVersion = JSON.parse(raw)?.version || "unknown";
} catch {}

const router = express.Router();

router.get("/live", noCache, (_req, res) => {
  res.json({ status: "ok" });
});

router.post("/stream-token", noCache, (req, res) => {
  const user = resolveRequestUser(req);
  if (!user) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "Authentication required" });
  }
  const token = issueStreamToken(user);
  return res.json({ token, expiresIn: 120 });
});

router.get("/", noCache, async (req, res) => {
  try {
    lidarrClient.updateConfig();
    const settings = dbOps.getSettings();
    const onboardingDone = settings.onboardingComplete;
    const authRequired = isAuthRequiredByConfig();
    const authUser = getAuthUser();
    const currentUser = resolveRequestUser(req);
    const payload = {
      status: "ok",
      authRequired,
      authUser: currentUser ? currentUser.username : authUser,
      onboardingRequired: !onboardingDone,
      timestamp: new Date().toISOString(),
    };
    if (currentUser) {
      const lidarrConfigured = lidarrClient.isConfigured();
      const discoveryCache = getDiscoveryCache();
      const wsStats = websocketService.getStats();
      const artistCount = getCachedArtistCount();
      payload.appVersion = process.env.APP_VERSION || rootPackageVersion || "unknown";
      payload.rootFolderConfigured = lidarrConfigured;
      payload.lidarrConfigured = lidarrConfigured;
      payload.lastfmConfigured = !!getLastfmApiKey();
      payload.ticketmasterConfigured = !!getTicketmasterApiKey();
      payload.musicbrainzConfigured = !!(
        settings.integrations?.musicbrainz?.email || process.env.CONTACT_EMAIL
      );
      payload.library = {
        artistCount: typeof artistCount === "number" ? artistCount : 0,
        lastScan: null,
      };
      payload.discovery = {
        lastUpdated: discoveryCache?.lastUpdated || null,
        isUpdating: !!discoveryCache?.isUpdating,
        recommendationsCount: discoveryCache?.recommendations?.length || 0,
        globalTopCount: discoveryCache?.globalTop?.length || 0,
        cachedImagesCount: dbOps.countImages(),
      };
      payload.websocket = {
        clients: wsStats.totalClients,
        channels: wsStats.channels,
      };
      payload.user = {
        id: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
        permissions: currentUser.permissions,
      };
    }
    res.json(payload);
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
});

router.get("/ws", requireAuth, noCache, (req, res) => {
  try {
    const stats = websocketService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get WebSocket stats",
    });
  }
});

export default router;
