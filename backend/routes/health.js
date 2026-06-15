import express from "express";
import {
  getLastfmApiKey,
  getTicketmasterApiKey,
  getMetadataProviderHealthSnapshot,
} from "../services/apiClients.js";
import { getSearchBaseUrl } from "../services/aurralSearchClient.js";
import { APP_VERSION } from "../config/constants.js";
import {
  resolveRequestUser,
  getAuthUser,
  isAuthRequiredByConfig,
  issueStreamToken,
  getLocalNetworkBypassStatus,
} from "../middleware/auth.js";
import {
  getDiscoveryCache,
  getDiscoveryUpdateStatus,
} from "../services/discoveryService.js";
import { getCachedArtistCount } from "../services/libraryManager.js";
import { lidarrClient } from "../services/lidarrClient.js";
import { dbOps } from "../config/db-helpers.js";
import { websocketService } from "../services/websocketService.js";
import { noCache } from "../middleware/cache.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { getImageProxyCacheSizeBytes } from "../services/imageProxyService.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  getDiscoveryCapabilities,
} from "../services/listenbrainzDiscoveryFallback.js";

const router = express.Router();

function buildBootstrapPayload(req) {
  lidarrClient.updateConfig();
  const settings = dbOps.getSettings();
  const onboardingDone = settings.onboardingComplete;
  const authRequired = isAuthRequiredByConfig();
  const authUser = getAuthUser();
  const currentUser = resolveRequestUser(req);
  const localNetworkBypass = getLocalNetworkBypassStatus(req);
  const lidarrConfigured = lidarrClient.isConfigured();

  const payload = {
    status: "ok",
    authRequired,
    authUser: currentUser ? currentUser.username : authUser,
    onboardingRequired: !onboardingDone,
    timestamp: new Date().toISOString(),
    appVersion: APP_VERSION,
    rootFolderConfigured: lidarrConfigured,
    lidarrConfigured,
    lastfmConfigured: !!getLastfmApiKey(),
    ticketmasterConfigured: !!getTicketmasterApiKey(),
    musicbrainzConfigured: !!settings.integrations?.metadata?.baseUrl,
    metadataConfigured: !!settings.integrations?.metadata?.baseUrl,
    searchConfigured: !!getSearchBaseUrl(),
    metadataProviders: getMetadataProviderHealthSnapshot(),
    localNetworkBypass,
  };

  if (currentUser) {
    payload.user = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
      permissions: currentUser.permissions,
    };
  }

  return payload;
}

router.get("/live", noCache, (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/bootstrap", noCache, (req, res) => {
  try {
    res.json(buildBootstrapPayload(req));
  } catch (error) {
    console.error("Bootstrap check error:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
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
    const settings = dbOps.getSettings();
    const currentUser = resolveRequestUser(req);
    const payload = buildBootstrapPayload(req);
    if (currentUser) {
      const discoveryCache = getDiscoveryCache();
      const wsStats = websocketService.getStats();
      const artistCount = getCachedArtistCount();
      payload.library = {
        artistCount: typeof artistCount === "number" ? artistCount : 0,
        lastScan: null,
      };
      const discoveryUpdateStatus = getDiscoveryUpdateStatus();
      payload.discovery = {
        provider: getLastfmApiKey()
          ? DISCOVERY_PROVIDER_LASTFM
          : DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
        capabilities: getDiscoveryCapabilities(!!getLastfmApiKey()),
        lastUpdated: discoveryCache?.lastUpdated || null,
        isUpdating: !!discoveryCache?.isUpdating,
        ...discoveryUpdateStatus,
        recommendationsCount: discoveryCache?.recommendations?.length || 0,
        globalTopCount: discoveryCache?.globalTop?.length || 0,
        cachedImagesCount: dbOps.countImages(),
        cachedImagesSizeBytes: getImageProxyCacheSizeBytes(),
      };
      payload.websocket = {
        clients: wsStats.totalClients,
        channels: wsStats.channels,
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
