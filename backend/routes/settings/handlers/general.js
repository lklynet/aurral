import { dbOps } from "../../../db/helpers/index.js";
import {
  DATE_TIME_FORMATS,
  DEFAULT_METADATA_BASE_URL,
  defaultData,
} from "../../../config/constants.js";
import { reconcileLocalNetworkBypassSetting } from "../../../middleware/auth.js";
import { noCache } from "../../../middleware/cache.js";
import { validateExternalUrl } from "../../../middleware/urlValidator.js";
import { websocketService } from "../../../services/websocketService.js";
import { resolvePlaylistRoot } from "../../../services/playlistPaths.js";
import {
  resolveYtdlpStagingRoot,
  validateDownloadFolderPath,
} from "../../../services/downloadFolderConfig.js";
import { normalizePathMappings } from "../../../services/pathMappings.js";
import { logger } from "../../../services/logger.js";
import { testNavidromeConnection } from "../../shared/navidromeTest.js";
import { mergePlexIntegration } from "./plexSettings.js";
import { getNewsSettings, normalizeNewsFeeds, normalizeNewsGroups } from "../../../services/apiClients/config.js";
import { normalizeQualityProfile } from "../../../services/qualityProfileModel.js";

function mergeIntegrations(existing, input, keys) {
  const merged = { ...existing, ...input };
  for (const key of keys) {
    merged[key] = input[key]
      ? { ...(existing[key] || {}), ...input[key] }
      : existing[key];
  }
  return merged;
}

export function registerGeneral(router) {
  router.post("/navidrome/test", testNavidromeConnection);

  router.get("/", noCache, (req, res) => {
    try {
      const settings = dbOps.getSettings();
      const legacyMusicbrainz = settings?.integrations?.musicbrainz || {};
      if (settings?.integrations?.coverArtArchive) {
        delete settings.integrations.coverArtArchive;
      }
      if (settings?.integrations?.musicbrainz) {
        delete settings.integrations.musicbrainz;
      }
      settings.integrations.news = getNewsSettings();
      if (!settings?.integrations?.metadata) {
        settings.integrations.metadata = {
          provider: "brainzmash",
          baseUrl: String(legacyMusicbrainz.customUrl || "").trim().replace(/\/ws\/2\/?$/, "") ||
              DEFAULT_METADATA_BASE_URL,
          userAgentSuffix: "",
          enableNarrowFallbacks: true,
        };
      } else {
        settings.integrations.metadata = {
          ...settings.integrations.metadata,
          baseUrl: String(settings.integrations.metadata.baseUrl || "").trim().replace(/\/+$/, "") ||
              DEFAULT_METADATA_BASE_URL,
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
        integrations: {
          ...(settings.integrations || {}),
          ytdlp: {
            ...(settings.integrations?.ytdlp || {}),
            stagingPath: resolveYtdlpStagingRoot(
              settings.integrations?.ytdlp?.stagingPath,
            ),
          },
        },
      });
    } catch (error) {
      logger.error("settings", "Settings GET error:", error);
      res
        .status(500)
        .json({ error: "Failed to fetch settings", message: error.message });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const {
        quality,
        qualityProfile,
        releaseTypes,
        integrations,
        rootFolderPath,
        downloadFolderPath,
        pathMappings,
        security,
        playlistArtwork,
        inbox,
        dateTimeFormat,
      } = req.body;

      if (dateTimeFormat !== undefined && !DATE_TIME_FORMATS.includes(dateTimeFormat)) {
        return res.status(400).json({ error: "Invalid date and time format" });
      }

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
        nextMetadata.baseUrl = String(baseUrlValidation.url || "").trim().replace(/\/+$/, "");
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
      if (integrations?.prowlarr) {
        const nextProwlarr = {
          ...(currentSettings.integrations?.prowlarr || {}),
          ...integrations.prowlarr,
        };
        const trimmedUrl = String(nextProwlarr.url || "").trim();
        if (trimmedUrl) {
          const urlValidation = validateExternalUrl(trimmedUrl);
          if (!urlValidation.valid) {
            return res.status(400).json({
              error: `Invalid Prowlarr URL: ${urlValidation.error}`,
            });
          }
          nextProwlarr.url = urlValidation.url.replace(/\/+$/, "");
        } else {
          nextProwlarr.url = "";
        }
        nextProwlarr.enabled = nextProwlarr.enabled === true;
        nextProwlarr.apiKey =
          typeof nextProwlarr.apiKey === "string"
            ? nextProwlarr.apiKey.trim()
            : "";
        nextProwlarr.categories = Array.isArray(nextProwlarr.categories)
          ? nextProwlarr.categories
              .map((entry) => Number.parseInt(entry, 10))
              .filter((entry) => Number.isFinite(entry) && entry > 0)
          : String(nextProwlarr.categories || "")
              .split(",")
              .map((entry) => Number.parseInt(entry.trim(), 10))
              .filter((entry) => Number.isFinite(entry) && entry > 0);
        if (nextProwlarr.categories.length === 0) {
          nextProwlarr.categories = [3000];
        }
        const maxResults = Number.parseInt(nextProwlarr.maxResults, 10);
        nextProwlarr.maxResults = Number.isFinite(maxResults)
          ? Math.min(200, Math.max(10, maxResults))
          : 60;
        const indexers =
          nextProwlarr.indexers && typeof nextProwlarr.indexers === "object"
            ? nextProwlarr.indexers
            : {};
        nextProwlarr.indexers = Object.fromEntries(
          Object.entries(indexers)
            .map(([id, entry]) => {
              const parsedId = Number.parseInt(id, 10);
              if (!Number.isFinite(parsedId)) return null;
              const priority = Number.parseInt(entry?.priority, 10);
              return [
                String(parsedId),
                {
                  enabled: entry?.enabled !== false,
                  priority: Number.isFinite(priority)
                    ? Math.min(1000, Math.max(1, priority))
                    : 25,
                },
              ];
            })
            .filter(Boolean),
        );
        integrations.prowlarr = nextProwlarr;
      }
      if (integrations?.nzbget) {
        const nextNzbget = {
          ...(currentSettings.integrations?.nzbget || {}),
          ...integrations.nzbget,
        };
        const trimmedUrl = String(nextNzbget.url || "").trim();
        if (trimmedUrl) {
          const urlValidation = validateExternalUrl(trimmedUrl);
          if (!urlValidation.valid) {
            return res.status(400).json({
              error: `Invalid NZBGet URL: ${urlValidation.error}`,
            });
          }
          nextNzbget.url = urlValidation.url.replace(/\/+$/, "");
        } else {
          nextNzbget.url = "";
        }
        nextNzbget.enabled = nextNzbget.enabled === true;
        nextNzbget.username =
          typeof nextNzbget.username === "string"
            ? nextNzbget.username.trim()
            : "";
        nextNzbget.password =
          typeof nextNzbget.password === "string" ? nextNzbget.password : "";
        nextNzbget.category =
          String(nextNzbget.category || "aurral").trim() || "aurral";
        const priority = Number.parseInt(nextNzbget.priority, 10);
        nextNzbget.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 20;
        const nzbPriority = Number.parseInt(nextNzbget.nzbPriority, 10);
        nextNzbget.nzbPriority = Number.isFinite(nzbPriority)
          ? Math.min(900, Math.max(-100, nzbPriority))
          : 0;
        nextNzbget.addPaused = nextNzbget.addPaused === true;
        nextNzbget.completedPath =
          typeof nextNzbget.completedPath === "string"
            ? nextNzbget.completedPath.trim()
            : "";
        integrations.nzbget = nextNzbget;
      }
      if (integrations?.slskd) {
        const priority = Number.parseInt(integrations.slskd.priority, 10);
        integrations.slskd.enabled = integrations.slskd.enabled === true;
        integrations.slskd.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 10;
      }
      if (integrations?.ytdlp) {
        const nextYtdlp = {
          ...(currentSettings.integrations?.ytdlp || {}),
          ...integrations.ytdlp,
        };
        nextYtdlp.enabled = nextYtdlp.enabled !== false;
        const priority = Number.parseInt(nextYtdlp.priority, 10);
        nextYtdlp.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 50;
        const stagingPath = resolveYtdlpStagingRoot(nextYtdlp.stagingPath);
        const validation = validateDownloadFolderPath(stagingPath, undefined, {
          create: true,
        });
        if (!validation.valid) {
          return res.status(400).json({
            error: `Invalid yt-dlp staging path: ${validation.error}`,
          });
        }
        nextYtdlp.stagingPath = validation.path;
        delete nextYtdlp.binaryPath;
        delete nextYtdlp.audioFormat;
        integrations.ytdlp = nextYtdlp;
      }
      if (integrations?.news) {
        const nextNews = {
          ...(currentSettings.integrations?.news || {}),
          ...integrations.news,
        };
        nextNews.enabled = nextNews.enabled !== false;
        nextNews.feeds = normalizeNewsFeeds(nextNews.feeds);
        nextNews.groups = normalizeNewsGroups(nextNews.groups);
        integrations.news = nextNews;
      }

      const INTEGRATION_KEYS = ["lidarr", "navidrome", "slskd", "prowlarr", "nzbget", "ytdlp", "lastfm", "ticketmaster", "news", "metadata", "general", "gotify", "webhookEvents"];
      let mergedIntegrations =
        currentSettings.integrations || defaultData.settings.integrations || {};
      if (integrations) {
        mergedIntegrations = mergeIntegrations(mergedIntegrations, integrations, INTEGRATION_KEYS);
        // mergeIntegrations()'s top-level spread already clobbered .plex down to
        // whatever partial fields the client sent (it isn't in INTEGRATION_KEYS,
        // which is why "plex" gets its own encryption-aware merge) - merge
        // against the true pre-request value, not that already-corrupted one.
        mergedIntegrations.plex = integrations.plex
          ? mergePlexIntegration(currentSettings.integrations?.plex, integrations.plex)
          : mergedIntegrations.plex;
        if (
          integrations.plex?.token &&
          integrations.plex.token !== currentSettings.integrations?.plex?.token
        ) {
          mergedIntegrations.plex = {
            ...mergedIntegrations.plex,
            configuredByUserId: req.user.id,
          };
        }
        mergedIntegrations.webhooks = integrations.webhooks !== undefined
          ? integrations.webhooks
          : mergedIntegrations.webhooks;
      }

      if (mergedIntegrations?.coverArtArchive) {
        delete mergedIntegrations.coverArtArchive;
      }
      const updatedSettings = {
        ...currentSettings,
        dateTimeFormat:
          dateTimeFormat !== undefined
            ? dateTimeFormat
            : currentSettings.dateTimeFormat || defaultData.settings.dateTimeFormat,
        quality:
          quality !== undefined ? quality : currentSettings.quality || "standard",
        qualityProfile:
          qualityProfile !== undefined
            ? normalizeQualityProfile(
                qualityProfile && typeof qualityProfile === "object" && !Array.isArray(qualityProfile)
                  ? { ...currentSettings.qualityProfile, ...qualityProfile }
                  : qualityProfile,
                integrations?.slskd,
              )
            : currentSettings.qualityProfile,
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
        inbox:
          inbox !== undefined
            ? {
                ...(currentSettings.inbox || defaultData.settings.inbox),
                ...inbox,
                enabled: inbox.enabled !== false,
                releases: inbox.releases !== false,
                shows: inbox.shows !== false,
                news: inbox.news !== false,
                recommendedNews: inbox.recommendedNews === true,
                discoveries: inbox.discoveries !== false,
              }
            : currentSettings.inbox || defaultData.settings.inbox,
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
      if (
        qualityProfile !== undefined &&
        JSON.stringify(updatedSettings.qualityProfile) !==
          JSON.stringify(currentSettings.qualityProfile)
      ) {
        const { enqueueSystemTaskJob } = await import(
          "../../../services/honkerDb.js"
        );
        enqueueSystemTaskJob(
          { kind: "quality-profile-refresh" },
          { priority: -10 },
        );
      }
      if (integrations?.navidrome) {
        const { playlistManager } = await import(
          "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js"
        );
        playlistManager.updateConfig(false);
        await playlistManager.ensureSmartPlaylists();
        playlistManager.scheduleScanLibrary(true);
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
      logger.error("settings", "Settings POST error:", error);
      res
        .status(500)
        .json({ error: "Failed to save settings", message: error.message });
    }
  });
}
