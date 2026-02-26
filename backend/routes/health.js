import express from "express";
import { readFileSync } from "fs";
import { getLastfmApiKey } from "../services/apiClients.js";
import {
  resolveRequestUser,
  getAuthUser,
  getAuthPassword,
  isProxyAuthEnabled,
} from "../middleware/auth.js";
import { getDiscoveryCache } from "../services/discoveryService.js";
import {
  getCachedArtistCount,
  getCachedAlbumCount,
  getCachedTrackCount,
  getTracksCacheSize,
  getLastSignalrActivityAt,
  getLastFullSyncAt,
} from "../services/libraryManager.js";
import { lidarrClient } from "../services/lidarrClient.js";
import { dbOps } from "../config/db-helpers.js";
import { userOps } from "../config/db-helpers.js";
import { websocketService } from "../services/websocketService.js";
import { noCache } from "../middleware/cache.js";

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

router.get("/", noCache, async (req, res) => {
  try {
    lidarrClient.updateConfig();
    const settings = dbOps.getSettings();
    const onboardingDone = settings.onboardingComplete;
    const users = userOps.getAllUsers();
    const legacyPasswords = getAuthPassword();
    const authRequired =
      onboardingDone &&
      (isProxyAuthEnabled() || users.length > 0 || legacyPasswords.length > 0);
    const authUser = getAuthUser();
    const lidarrConfigured = lidarrClient.isConfigured();
    const discoveryCache = getDiscoveryCache();
    const wsStats = websocketService.getStats();
    const artistCount = getCachedArtistCount();
    const albumCount = getCachedAlbumCount();
    const trackCount = getCachedTrackCount();
    const tracksCacheSize = getTracksCacheSize();
    const lastFullSyncAt = getLastFullSyncAt();
    const lastSignalrActivityAt = getLastSignalrActivityAt();

    const currentUser = resolveRequestUser(req);
    const payload = {
      status: "ok",
      appVersion: process.env.APP_VERSION || rootPackageVersion || "unknown",
      rootFolderConfigured: lidarrConfigured,
      lidarrConfigured,
      lastfmConfigured: !!getLastfmApiKey(),
      musicbrainzConfigured: !!(
        settings.integrations?.musicbrainz?.email || process.env.CONTACT_EMAIL
      ),
      library: {
        artistCount: typeof artistCount === "number" ? artistCount : 0,
        albumCount: typeof albumCount === "number" ? albumCount : 0,
        trackCount: typeof trackCount === "number" ? trackCount : 0,
        tracksCacheSize:
          typeof tracksCacheSize === "number" ? tracksCacheSize : 0,
        lastFullSyncAt,
        lastSignalrActivityAt,
        lastScan: null,
      },
      discovery: {
        lastUpdated: discoveryCache?.lastUpdated || null,
        isUpdating: !!discoveryCache?.isUpdating,
        recommendationsCount: discoveryCache?.recommendations?.length || 0,
        globalTopCount: discoveryCache?.globalTop?.length || 0,
        cachedImagesCount: dbOps.getAllImages()
          ? Object.keys(dbOps.getAllImages()).length
          : 0,
      },
      websocket: {
        clients: wsStats.totalClients,
        channels: wsStats.channels,
      },
      authRequired,
      authUser: currentUser ? currentUser.username : authUser,
      onboardingRequired: !onboardingDone,
      timestamp: new Date().toISOString(),
    };
    if (currentUser) {
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
      status: "error",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get("/ws", noCache, (req, res) => {
  try {
    const stats = websocketService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get WebSocket stats",
      message: error.message,
    });
  }
});

export default router;
