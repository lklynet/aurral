import express from "express";
import { dbOps } from "../config/db-helpers.js";
import {
  DEFAULT_METADATA_BASE_URL,
  DEFAULT_SEARCH_URL,
  LEGACY_METADATA_BASE_URL,
  defaultData,
} from "../config/constants.js";
import { reconcileLocalNetworkBypassSetting } from "../middleware/auth.js";
import { noCache } from "../middleware/cache.js";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { websocketService } from "../services/websocketService.js";
import { resolvePlaylistRoot } from "../services/playlistPaths.js";
import { normalizePathMappings } from "../services/pathMappings.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

function normalizeMetadataBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  return trimmed === LEGACY_METADATA_BASE_URL ? DEFAULT_METADATA_BASE_URL : trimmed;
}

router.get("/", noCache, (req, res) => {
  try {
    const settings = dbOps.getSettings();
    if (settings?.integrations?.coverArtArchive) {
      delete settings.integrations.coverArtArchive;
    }
    if (settings?.integrations?.musicbrainz) {
      delete settings.integrations.musicbrainz;
    }
    if (!settings?.integrations?.search) {
      settings.integrations.search = {
        url: DEFAULT_SEARCH_URL,
        apiKey: "",
      };
    } else {
      settings.integrations.search = {
        url: settings.integrations.search.url || DEFAULT_SEARCH_URL,
        apiKey: settings.integrations.search.apiKey || "",
      };
    }
    if (!settings?.integrations?.metadata) {
      const legacyMusicbrainz = dbOps.getSettings()?.integrations?.musicbrainz || {};
      settings.integrations.metadata = {
        provider: "brainzmash",
        baseUrl: normalizeMetadataBaseUrl(
          String(legacyMusicbrainz.customUrl || "").trim().replace(/\/ws\/2\/?$/, "") ||
            DEFAULT_METADATA_BASE_URL,
        ),
        userAgentSuffix: "",
        enableNarrowFallbacks: true,
      };
    } else {
      settings.integrations.metadata = {
        ...settings.integrations.metadata,
        baseUrl: normalizeMetadataBaseUrl(
          settings.integrations.metadata.baseUrl || DEFAULT_METADATA_BASE_URL,
        ),
      };
    }
    settings.security = {
      ...(settings.security || {}),
      localNetworkBypass: {
        enabled: settings?.security?.localNetworkBypass?.enabled === true,
      },
    };
    res.json({
      ...settings,
      downloadFolderPath:
        settings.downloadFolderPath || resolvePlaylistRoot(),
    });
  } catch (error) {
    console.error("Settings GET error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch settings", message: error.message });
  }
});

router.post("/slskd/test", async (req, res) => {
  try {
    const { slskdClient } = await import("../services/slskdClient.js");
    const result = await slskdClient.testConnection({ force: true });
    if (!result.configured) {
      return res.status(400).json(result);
    }
    if (!result.ok) {
      return res.status(502).json(result);
    }
    return res.json({
      success: true,
      warning: result.warning === true,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      error: "slskd test failed",
      message: error.message,
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      quality,
      releaseTypes,
      integrations,
      rootFolderPath,
      downloadFolderPath,
      pathMappings,
      security,
      playlistArtwork,
    } = req.body;

    const currentSettings = dbOps.getSettings();
    const localBypassWasEnabled =
      currentSettings?.security?.localNetworkBypass?.enabled === true;
    const lidarrExternalUrl = integrations?.lidarr?.externalUrl;
    if (lidarrExternalUrl !== undefined) {
      const trimmedExternalUrl = String(lidarrExternalUrl).trim();
      if (trimmedExternalUrl) {
        const urlValidation = validateExternalUrl(trimmedExternalUrl);
        if (!urlValidation.valid) {
          return res.status(400).json({ error: urlValidation.error });
        }
        integrations.lidarr.externalUrl = urlValidation.url;
      } else {
        integrations.lidarr.externalUrl = "";
      }
    }

    if (integrations?.search) {
      const nextSearch = {
        ...(currentSettings.integrations?.search || {}),
        ...integrations.search,
      };
      const trimmedSearchUrl = String(nextSearch.url || "").trim();
      if (trimmedSearchUrl) {
        const urlValidation = validateExternalUrl(trimmedSearchUrl);
        if (!urlValidation.valid) {
          return res.status(400).json({
            error: `Invalid search URL: ${urlValidation.error}`,
          });
        }
        nextSearch.url = urlValidation.url.replace(/\/+$/, "");
      } else {
        nextSearch.url = "";
      }
      nextSearch.apiKey =
        typeof nextSearch.apiKey === "string" ? nextSearch.apiKey.trim() : "";
      integrations.search = nextSearch;
    }
    if (integrations?.metadata) {
      const nextMetadata = {
        ...(currentSettings.integrations?.metadata || {}),
        ...integrations.metadata,
      };
      nextMetadata.provider = "brainzmash";
      const baseUrlValidation = validateExternalUrl(nextMetadata.baseUrl || "");
      if (!baseUrlValidation.valid) {
        return res.status(400).json({
          error: `Invalid metadata base URL: ${baseUrlValidation.error}`,
        });
      }
      nextMetadata.baseUrl = normalizeMetadataBaseUrl(baseUrlValidation.url);
      nextMetadata.userAgentSuffix =
        typeof nextMetadata.userAgentSuffix === "string"
          ? nextMetadata.userAgentSuffix.trim()
          : "";
      nextMetadata.enableNarrowFallbacks =
        nextMetadata.enableNarrowFallbacks !== false;
      integrations.metadata = nextMetadata;
    }
    if (integrations?.coverArtArchive) {
      delete integrations.coverArtArchive;
    }

    let mergedIntegrations =
      currentSettings.integrations || defaultData.settings.integrations || {};
    if (integrations) {
      mergedIntegrations = {
        ...mergedIntegrations,
        ...integrations,
        lidarr: integrations.lidarr
          ? {
              ...(mergedIntegrations.lidarr || {}),
              ...integrations.lidarr,
            }
          : mergedIntegrations.lidarr,
        navidrome: integrations.navidrome
          ? {
              ...(mergedIntegrations.navidrome || {}),
              ...integrations.navidrome,
            }
          : mergedIntegrations.navidrome,
        plex: integrations.plex
          ? {
              ...(mergedIntegrations.plex || {}),
              ...integrations.plex,
              // Never let a blank token/clientId from the client wipe the
              // stored credentials (the UI doesn't always carry them).
              token:
                integrations.plex.token ||
                mergedIntegrations.plex?.token ||
                "",
              clientId:
                integrations.plex.clientId ||
                mergedIntegrations.plex?.clientId ||
                "",
            }
          : mergedIntegrations.plex,
        slskd: integrations.slskd
          ? {
              ...(mergedIntegrations.slskd || {}),
              ...integrations.slskd,
            }
          : mergedIntegrations.slskd,
        lastfm: integrations.lastfm
          ? {
              ...(mergedIntegrations.lastfm || {}),
              ...integrations.lastfm,
            }
          : mergedIntegrations.lastfm,
        ticketmaster: integrations.ticketmaster
          ? {
              ...(mergedIntegrations.ticketmaster || {}),
              ...integrations.ticketmaster,
            }
          : mergedIntegrations.ticketmaster,
        metadata: integrations.metadata
          ? {
              ...(mergedIntegrations.metadata || {}),
              ...integrations.metadata,
            }
          : mergedIntegrations.metadata,
        search: integrations.search
          ? {
              ...(mergedIntegrations.search || {}),
              ...integrations.search,
            }
          : mergedIntegrations.search,
        general: integrations.general
          ? {
              ...(mergedIntegrations.general || {}),
              ...integrations.general,
            }
          : mergedIntegrations.general,
        gotify: integrations.gotify
          ? {
              ...(mergedIntegrations.gotify || {}),
              ...integrations.gotify,
            }
          : mergedIntegrations.gotify,
        webhooks: integrations.webhooks !== undefined
          ? integrations.webhooks
          : mergedIntegrations.webhooks,
        webhookEvents: integrations.webhookEvents
          ? {
              ...(mergedIntegrations.webhookEvents || {}),
              ...integrations.webhookEvents,
            }
          : mergedIntegrations.webhookEvents,
      };
    }

    if (mergedIntegrations?.coverArtArchive) {
      delete mergedIntegrations.coverArtArchive;
    }

    const updatedSettings = {
      ...currentSettings,
      quality:
        quality !== undefined ? quality : currentSettings.quality || "standard",
      rootFolderPath:
        rootFolderPath !== undefined
          ? rootFolderPath
          : currentSettings.rootFolderPath || null,
      downloadFolderPath:
        downloadFolderPath !== undefined
          ? downloadFolderPath
          : currentSettings.downloadFolderPath || null,
      pathMappings:
        pathMappings !== undefined
          ? normalizePathMappings(pathMappings)
          : currentSettings.pathMappings || [],
      releaseTypes:
        releaseTypes !== undefined
          ? releaseTypes
          : currentSettings.releaseTypes || defaultData.settings.releaseTypes,
      integrations: mergedIntegrations,
      security:
        security !== undefined
          ? {
              ...(currentSettings.security || {}),
              ...security,
              localNetworkBypass: security.localNetworkBypass
                ? {
                    ...(
                      currentSettings.security?.localNetworkBypass ||
                      defaultData.settings.security.localNetworkBypass
                    ),
                    ...security.localNetworkBypass,
                    enabled: security.localNetworkBypass.enabled === true,
                  }
                : currentSettings.security?.localNetworkBypass ||
                  defaultData.settings.security.localNetworkBypass,
            }
          : currentSettings.security || defaultData.settings.security,
      playlistArtwork:
        playlistArtwork !== undefined
          ? {
              ...(currentSettings.playlistArtwork ||
                defaultData.settings.playlistArtwork),
              ...playlistArtwork,
            }
          : currentSettings.playlistArtwork ||
            defaultData.settings.playlistArtwork,
    };

    if (updatedSettings?.integrations?.coverArtArchive) {
      delete updatedSettings.integrations.coverArtArchive;
    }
    if (updatedSettings?.integrations?.musicbrainz) {
      delete updatedSettings.integrations.musicbrainz;
    }

    dbOps.updateSettings(updatedSettings);
    if (downloadFolderPath !== undefined) {
      const { refreshPlaylistRuntimeRoots } = await import(
        "../services/playlistRuntime.js"
      );
      await refreshPlaylistRuntimeRoots();
    }
    const reconciled = reconcileLocalNetworkBypassSetting().settings;
    if (
      localBypassWasEnabled &&
      reconciled?.security?.localNetworkBypass?.enabled !== true
    ) {
      websocketService.reconcileAuthState();
    }
    res.json(reconciled);
  } catch (error) {
    console.error("Settings POST error:", error);
    res
      .status(500)
      .json({ error: "Failed to save settings", message: error.message });
  }
});

router.get("/logs", async (req, res) => {
  try {
    const { logger } = await import("../services/logger.js");
    const { limit = 100, category, level } = req.query;

    const logs = logger.getRecentLogs({
      limit: parseInt(limit, 10),
      category,
      level,
    });

    res.json({
      logs,
      count: logs.length,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to get logs", message: error.message });
  }
});

router.get("/logs/stats", async (req, res) => {
  try {
    const { logger } = await import("../services/logger.js");
    const stats = logger.getLogStats();
    res.json(stats);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to get log stats", message: error.message });
  }
});

router.get("/lidarr/profiles", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");

    const testUrl = req.query.url;
    const testApiKey = req.query.apiKey;

    let url, apiKey;
    if (testUrl && testApiKey) {
      url = testUrl.trim();
      apiKey = testApiKey.trim();
    } else {
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      url = config.url;
      apiKey = config.apiKey;
    }

    if (!url || !apiKey) {
      return res.status(400).json({
        error: "Lidarr not configured",
        message: "Please configure Lidarr URL and API key in settings first",
      });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;

    const originalConfig = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;

    lidarrClient.config = {
      url: url.replace(/\/+$/, ""),
      apiKey: apiKey.trim(),
    };
    lidarrClient.apiPath = "/api/v1";

    try {
      const profiles = await lidarrClient.getQualityProfiles(true);
      res.json(profiles);
    } finally {
      lidarrClient.config = originalConfig;
      lidarrClient.apiPath = originalApiPath;
      lidarrClient.updateConfig();
    }
  } catch (error) {
    console.error("[Settings] Failed to fetch Lidarr profiles:", error);
    res.status(500).json({
      error: "Failed to fetch Lidarr quality profiles",
      message: error.message,
      details: error.response?.data,
    });
  }
});

router.get("/lidarr/metadata-profiles", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");

    const testUrl = req.query.url;
    const testApiKey = req.query.apiKey;

    let url, apiKey;
    if (testUrl && testApiKey) {
      url = testUrl.trim();
      apiKey = testApiKey.trim();
    } else {
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      url = config.url;
      apiKey = config.apiKey;
    }

    if (!url || !apiKey) {
      return res.status(400).json({
        error: "Lidarr not configured",
        message: "Please configure Lidarr URL and API key in settings first",
      });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;

    const originalConfig = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;

    lidarrClient.config = {
      url: url.replace(/\/+$/, ""),
      apiKey: apiKey.trim(),
    };
    lidarrClient.apiPath = "/api/v1";

    try {
      const profiles = await lidarrClient.getMetadataProfiles(true);
      res.json(profiles);
    } finally {
      lidarrClient.config = originalConfig;
      lidarrClient.apiPath = originalApiPath;
      lidarrClient.updateConfig();
    }
  } catch (error) {
    console.error(
      "[Settings] Failed to fetch Lidarr metadata profiles:",
      error,
    );
    res.status(500).json({
      error: "Failed to fetch Lidarr metadata profiles",
      message: error.message,
      details: error.response?.data,
    });
  }
});

router.get("/lidarr/tags", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");

    const testUrl = req.query.url;
    const testApiKey = req.query.apiKey;

    let url, apiKey;
    if (testUrl && testApiKey) {
      url = testUrl.trim();
      apiKey = testApiKey.trim();
    } else {
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      url = config.url;
      apiKey = config.apiKey;
    }

    if (!url || !apiKey) {
      return res.status(400).json({
        error: "Lidarr not configured",
        message: "Please configure Lidarr URL and API key in settings first",
      });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;

    const originalConfig = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;

    lidarrClient.config = {
      url: url.replace(/\/+$/, ""),
      apiKey: apiKey.trim(),
    };
    lidarrClient.apiPath = "/api/v1";

    try {
      const tags = await lidarrClient.getTags(true);
      res.json(tags);
    } finally {
      lidarrClient.config = originalConfig;
      lidarrClient.apiPath = originalApiPath;
      lidarrClient.updateConfig();
    }
  } catch (error) {
    console.error("[Settings] Failed to fetch Lidarr tags:", error);
    res.status(500).json({
      error: "Failed to fetch Lidarr tags",
      message: error.message,
      details: error.response?.data,
    });
  }
});

router.post("/path-mappings/detect", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    const { slskdClient } = await import("../services/slskdClient.js");
    const { detectPathMappings } = await import("../services/pathMappings.js");

    const externalPaths = [];
    const samplePaths = [];

    try {
      lidarrClient.updateConfig();
      const rootFolders = await lidarrClient.getRootFolders();
      for (const folder of Array.isArray(rootFolders) ? rootFolders : []) {
        const rootPath = String(folder?.path || "").trim();
        if (rootPath) externalPaths.push(rootPath);
      }
    } catch {}

    try {
      const slskdRoot = await slskdClient.getDownloadDirectory();
      if (slskdRoot) externalPaths.push(slskdRoot);
    } catch {}

    const detection = await detectPathMappings({
      externalPaths,
      samplePaths,
    });

    res.json({
      success: true,
      mappings: detection.mappings,
      verified: detection.verified === true,
      sampleLocalPath: detection.sampleLocalPath || null,
    });
  } catch (error) {
    res.status(500).json({
      error: "Path mapping detection failed",
      message: error.message,
    });
  }
});

router.get("/lidarr/test-library-access", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    const { resolveLidarrTestCredentials, validateLidarrTestCredentials, withTemporaryLidarrClient } =
      await import("../services/lidarrTestSession.js");
    const { runLidarrLibraryAccessTest } =
      await import("../services/lidarrLibraryAccessTest.js");

    const { url, apiKey } = resolveLidarrTestCredentials(req.query, lidarrClient);
    const validation = validateLidarrTestCredentials(url, apiKey);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const result = await withTemporaryLidarrClient(validation.url, apiKey, (client) =>
      runLidarrLibraryAccessTest(client, { autoApplyMappings: true }),
    );

    res.json({
      success: result.ok,
      ok: result.ok,
      partial: !!result.partial,
      steps: result.steps,
      sample: result.sample,
      appliedMappings: result.appliedMappings || [],
      suggestedMappings: result.suggestedMappings || [],
    });
  } catch (error) {
    console.error("[Settings] Lidarr library access test error:", error);
    res.status(500).json({
      error: "Library access check failed",
      message: error.message,
    });
  }
});

router.get("/lidarr/test", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");

    const testUrl = req.query.url;
    const testApiKey = req.query.apiKey;

    let url, apiKey;
    if (testUrl && testApiKey) {
      url = testUrl.trim();
      apiKey = testApiKey.trim();
    } else {
      lidarrClient.updateConfig();
      const config = lidarrClient.getConfig();
      url = config.url;
      apiKey = config.apiKey;
    }

    console.log("[Settings] Testing Lidarr connection...", {
      url: url,
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length || 0,
      usingProvided: !!(testUrl && testApiKey),
    });

    if (!url || !apiKey) {
      return res
        .status(400)
        .json({ error: "Lidarr URL and API key are required" });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;

    const originalConfig = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;

    lidarrClient.config = {
      url: url.replace(/\/+$/, ""),
      apiKey: apiKey.trim(),
    };
    lidarrClient.apiPath = "/api/v1";

    try {
      const result = await lidarrClient.testConnection(true);
      console.log("[Settings] Lidarr test result:", result);

      if (result.connected) {
        res.json({
          success: true,
          message: "Connection successful",
          version: result.version,
          instanceName: result.instanceName,
          apiPath: result.apiPath,
        });
      } else {
        res.status(400).json({
          error: "Connection failed",
          message: result.error,
          details: result.details,
          url: result.url,
          fullUrl: result.fullUrl,
          statusCode: result.statusCode,
          apiPath: result.apiPath,
        });
      }
    } finally {
      lidarrClient.config = originalConfig;
      lidarrClient.apiPath = originalApiPath;
      lidarrClient.updateConfig();
    }
  } catch (error) {
    console.error("[Settings] Lidarr test error:", error);
    res.status(500).json({
      error: "Connection failed",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

router.post("/gotify/test", async (req, res) => {
  try {
    const { sendGotifyTest } =
      await import("../services/notificationService.js");
    const url = req.body?.url?.trim();
    const token = req.body?.token?.trim();
    if (!url || !token) {
      return res.status(400).json({
        error: "URL and token required",
        message: "Provide Gotify URL and application token in the request body",
      });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    await sendGotifyTest(urlValidation.url, token);
    res.json({ success: true, message: "Test notification sent" });
  } catch (error) {
    if (error.code === "MISSING_CONFIG") {
      return res.status(400).json({
        error: "Invalid configuration",
        message: error.message,
      });
    }
    const status = error.response?.status;
    const msg =
      error.response?.data?.description ||
      error.response?.data?.error ||
      error.message;
    res
      .status(status && status >= 400 ? status : 500)
      .json({ error: "Gotify test failed", message: msg });
  }
});

router.post("/lidarr/apply-community-guide", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    const { applyLidarrCommunityGuide } =
      await import("../services/lidarrCommunityGuide.js");

    lidarrClient.updateConfig();
    const config = lidarrClient.getConfig();

    if (!config.url || !config.apiKey) {
      return res.status(400).json({
        error: "Lidarr not configured",
        message: "Please configure Lidarr URL and API key in settings first",
      });
    }

    try {
      const results = await applyLidarrCommunityGuide(lidarrClient);

      const currentSettings = dbOps.getSettings();
      dbOps.updateSettings({
        ...currentSettings,
        integrations: {
          ...currentSettings.integrations,
          lidarr: {
            ...(currentSettings.integrations?.lidarr || {}),
            qualityProfileId: results.qualityProfile?.id || null,
            metadataProfileId: results.metadataProfile?.id || null,
          },
        },
      });

      res.json({
        success: true,
        message: "Community guide settings applied successfully",
        results,
      });
    } catch (error) {
      console.error("[Settings] Failed to apply community guide:", error);
      res.status(500).json({
        error: "Failed to apply community guide settings",
        message: error.message,
        details: error.response?.data,
        partialResults: error.partialResults,
      });
    }
  } catch (error) {
    console.error("[Settings] Error applying community guide:", error);
    res.status(500).json({
      error: "Failed to apply community guide settings",
      message: error.message,
    });
  }
});

router.get("/browse", async (req, res) => {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const target = path.resolve(req.query.path ? String(req.query.path) : "/");
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const directories = (
      await Promise.all(
        dirents.map(async (d) => {
          let isDir = d.isDirectory();
          if (!isDir && d.isSymbolicLink()) {
            try {
              isDir = (await fs.stat(path.join(target, d.name))).isDirectory();
            } catch {
              isDir = false;
            }
          }
          return isDir ? { name: d.name, path: path.join(target, d.name) } : null;
        }),
      )
    )
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      path: target,
      parent: target === "/" ? null : path.dirname(target),
      directories,
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: "Cannot read path", message: error.message });
  }
});

function getPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

router.post("/plex/auth/pin", async (req, res) => {
  try {
    const { PlexClient } = await import("../services/plex.js");
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
    console.error("[Settings] Plex PIN generation failed:", error.message);
    res.status(500).json({
      error: "Failed to start Plex authentication",
      message: error.message,
    });
  }
});

router.post("/plex/auth/check", async (req, res) => {
  try {
    const { PlexClient } = await import("../services/plex.js");
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
    res.json({ token });
  } catch (error) {
    console.error("[Settings] Plex PIN check failed:", error.message);
    res.status(500).json({
      error: "Failed to check Plex authentication",
      message: error.message,
    });
  }
});

router.post("/plex/resources", async (req, res) => {
  try {
    const { PlexClient } = await import("../services/plex.js");
    const stored = getPlexConfig();
    // Use the freshest token the client has (e.g. just-minted during connect),
    // falling back to the persisted one. The clientId MUST be the stored one
    // the token was minted under — Plex ties the token to that identifier.
    const token = req.body?.token || stored.token;
    const clientId = stored.clientId;
    if (!token || !clientId) {
      return res.status(400).json({ error: "Plex authentication required" });
    }
    const { servers, total } = await PlexClient.getResources(token, clientId);
    res.json({ servers, total });
  } catch (error) {
    const status = error.response?.status;
    console.error(
      "[Settings] Plex resources failed:",
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
    const { PlexClient } = await import("../services/plex.js");
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
      message: error.response?.data || error.message,
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
      "../services/weeklyFlowPlaylistManager.js"
    );
    playlistManager.updateConfig(false);
    const result = await playlistManager.syncPlexNow();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("[Settings] Plex sync failed:", error.message);
    res.status(500).json({
      error: "Plex sync failed",
      message: error.response?.data || error.message,
    });
  }
});

router.post("/logs/level", async (req, res) => {
  try {
    const { logger } = await import("../services/logger.js");
    const { level, category } = req.body;

    if (!level) {
      return res.status(400).json({ error: "level is required" });
    }

    if (category) {
      logger.setCategoryLevel(category, level);
      res.json({ message: `Log level for ${category} set to ${level}` });
    } else {
      logger.setLevel(level);
      res.json({ message: `Global log level set to ${level}` });
    }
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to set log level", message: error.message });
  }
});

export default router;
