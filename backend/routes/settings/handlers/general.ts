import type { Router } from "express";
import { isDeepStrictEqual } from "node:util";
import { dbOps } from "../../../db/helpers/index.ts";
import { MAX_REVIEW_TIMEOUT_HOURS } from "../../../db/helpers/settings.ts";
import type { AppSettings, StoredIntegrations } from "../../../db/helpers/settings.ts";
import {
  DATE_TIME_FORMATS,
  DEFAULT_METADATA_BASE_URL,
  defaultData,
} from "../../../config/constants.ts";
import { reconcileLocalNetworkBypassSetting } from "../../../middleware/auth.ts";
import { noCache } from "../../../middleware/cache.ts";
import { validateExternalUrl } from "../../../middleware/urlValidator.ts";
import { websocketService } from "../../../services/websocketService.ts";
import { resolveDownloadRoot } from "../../../services/downloadPaths.ts";
import {
  resolveYtdlpStagingRoot,
  validateDownloadFolderPath,
  computeLibraryRootOverlaps,
  getOverlapCheckedLidarrRoots,
} from "../../../services/downloadFolderConfig.ts";
import { normalizePathMappings } from "../../../services/pathMappings.ts";
import { readOnlyFolderOverlapping } from "../../../services/libraryFolders.ts";
import { logger } from "../../../services/logger.ts";
import { normalizeLidarrApiKey, normalizeLidarrUrl } from "../../../services/lidarrClient.ts";
import { testNavidromeConnection } from "../../shared/navidromeTest.ts";
import { mergePlexIntegration } from "./plexSettings.ts";
import {
  getNewsSettings,
  normalizeNewsFeeds,
  normalizeNewsGroups,
} from "../../../services/apiClients/config.ts";
import { normalizeQualityProfile } from "../../../services/qualityProfileModel.ts";
import { getMusicDataSourceName } from "../../../services/musicDataSource/index.ts";
import { asAppError } from "../../../../lib/errors.ts";

type ProwlarrIndexers = NonNullable<NonNullable<StoredIntegrations["prowlarr"]>["indexers"]>;

function mergeIntegrations(
  existing: StoredIntegrations,
  input: StoredIntegrations,
  keys: string[],
) {
  const merged = { ...existing, ...input };
  for (const key of keys) {
    merged[key] = input[key] ? { ...(existing[key] || {}), ...input[key] } : existing[key];
  }
  return merged;
}

function resolveLibraryRootWarnings(settings: AppSettings) {
  const aurralRoot = settings?.downloadFolderPath || resolveDownloadRoot();
  const lidarrRoots = getOverlapCheckedLidarrRoots(settings?.integrations?.lidarr);
  return computeLibraryRootOverlaps({ aurralRoot, lidarrRoots });
}

function didLidarrRootDiscoveryChange(previousSettings: AppSettings, nextSettings: AppSettings) {
  const previous = previousSettings?.integrations?.lidarr || {};
  const next = nextSettings?.integrations?.lidarr || {};
  return (
    ["url", "apiKey", "enabled", "insecure", "rootFolderPath", "rootFolderPaths"] as const
  ).some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

function didLidarrConnectionChange(previousSettings: AppSettings, nextSettings: AppSettings) {
  const previous = previousSettings?.integrations?.lidarr || {};
  const next = nextSettings?.integrations?.lidarr || {};
  return (
    normalizeLidarrUrl(previous.url) !== normalizeLidarrUrl(next.url) ||
    normalizeLidarrApiKey(previous.apiKey) !== normalizeLidarrApiKey(next.apiKey)
  );
}

export function registerGeneral(router: Router) {
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
          baseUrl:
            String(legacyMusicbrainz.customUrl || "")
              .trim()
              .replace(/\/ws\/2\/?$/, "") || DEFAULT_METADATA_BASE_URL,
          userAgentSuffix: "",
          enableNarrowFallbacks: true,
        };
      } else {
        settings.integrations.metadata = {
          ...settings.integrations.metadata,
          baseUrl:
            String(settings.integrations.metadata.baseUrl || "")
              .trim()
              .replace(/\/+$/, "") || DEFAULT_METADATA_BASE_URL,
        };
      }
      settings.security = {
        ...(settings.security || {}),
        localNetworkBypass: {
          enabled: settings?.security?.localNetworkBypass?.enabled === true,
        },
      };
      if (settings.integrations?.lidarr) {
        settings.integrations.lidarr = {
          ...settings.integrations.lidarr,
          enabled: settings.integrations.lidarr.enabled !== false,
        };
      }
      res.json({
        ...settings,
        rootWarnings: resolveLibraryRootWarnings(settings),
        downloadFolderPath: settings.downloadFolderPath || resolveDownloadRoot(),
        integrations: {
          ...(settings.integrations || {}),
          ytdlp: {
            ...(settings.integrations?.ytdlp || {}),
            stagingPath: resolveYtdlpStagingRoot(settings.integrations?.ytdlp?.stagingPath),
          },
        },
      });
    } catch (error) {
      logger.error("settings", "Settings GET error:", error ?? undefined);
      res
        .status(500)
        .json({ error: "Failed to fetch settings", message: asAppError(error)?.message });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const {
        quality,
        qualityProfile,
        subsonic,
        releaseTypes,
        integrations,
        rootFolderPath,
        downloadFolderPath,
        pathMappings,
        security,
        missingTrackSearch,
        inbox,
        dateTimeFormat,
        reviewTimeoutHours,
      } = req.body;

      if (dateTimeFormat !== undefined && !DATE_TIME_FORMATS.includes(dateTimeFormat)) {
        return res.status(400).json({ error: "Invalid date and time format" });
      }
      if (
        reviewTimeoutHours !== undefined &&
        (!Number.isInteger(reviewTimeoutHours) ||
          reviewTimeoutHours < 0 ||
          reviewTimeoutHours > MAX_REVIEW_TIMEOUT_HOURS)
      ) {
        return res.status(400).json({
          error: `reviewTimeoutHours must be a whole number from 0 to ${MAX_REVIEW_TIMEOUT_HOURS}`,
        });
      }

      const readOnlyOverlap =
        typeof downloadFolderPath === "string" && downloadFolderPath.trim()
          ? readOnlyFolderOverlapping(downloadFolderPath.trim())
          : null;
      if (readOnlyOverlap) {
        return res.status(400).json({
          error: `The Downloads Folder cannot overlap the read-only folder ${readOnlyOverlap}. Choose another folder, or remove the read-only folder in Settings > Library files.`,
        });
      }

      const currentSettings = dbOps.getSettings();
      const localBypassWasEnabled = currentSettings?.security?.localNetworkBypass?.enabled === true;
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
        nextMetadata.baseUrl = String(baseUrlValidation.url || "")
          .trim()
          .replace(/\/+$/, "");
        nextMetadata.userAgentSuffix =
          typeof nextMetadata.userAgentSuffix === "string"
            ? nextMetadata.userAgentSuffix.trim()
            : "";
        nextMetadata.enableNarrowFallbacks = nextMetadata.enableNarrowFallbacks !== false;
        integrations.metadata = nextMetadata;
      }
      if (integrations?.lidarr?.enabled !== undefined) {
        integrations.lidarr = {
          ...integrations.lidarr,
          enabled: integrations.lidarr.enabled === true,
        };
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
          typeof nextProwlarr.apiKey === "string" ? nextProwlarr.apiKey.trim() : "";
        nextProwlarr.categories = Array.isArray(nextProwlarr.categories)
          ? nextProwlarr.categories
              .map((entry: unknown) => Number.parseInt(String(entry), 10))
              .filter((entry: number) => Number.isFinite(entry) && entry > 0)
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
        const indexers: ProwlarrIndexers =
          nextProwlarr.indexers && typeof nextProwlarr.indexers === "object"
            ? nextProwlarr.indexers
            : {};
        nextProwlarr.indexers = Object.fromEntries(
          Object.entries(indexers)
            .map(([id, entry]): [string, { enabled: boolean; priority: number }] | null => {
              const parsedId = Number.parseInt(id, 10);
              if (!Number.isFinite(parsedId)) return null;
              const priority = Number.parseInt(String(entry?.priority), 10);
              return [
                String(parsedId),
                {
                  enabled: entry?.enabled !== false,
                  priority: Number.isFinite(priority) ? Math.min(1000, Math.max(1, priority)) : 25,
                },
              ];
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
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
          typeof nextNzbget.username === "string" ? nextNzbget.username.trim() : "";
        nextNzbget.password = typeof nextNzbget.password === "string" ? nextNzbget.password : "";
        nextNzbget.category = String(nextNzbget.category || "aurral").trim() || "aurral";
        const priority = Number.parseInt(nextNzbget.priority, 10);
        nextNzbget.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 20;
        const nzbPriority = Number.parseInt(nextNzbget.nzbPriority, 10);
        nextNzbget.nzbPriority = Number.isFinite(nzbPriority)
          ? Math.min(900, Math.max(-100, nzbPriority))
          : 0;
        nextNzbget.addPaused = nextNzbget.addPaused === true;
        nextNzbget.deleteLeftovers = nextNzbget.deleteLeftovers !== false;
        nextNzbget.completedPath =
          typeof nextNzbget.completedPath === "string" ? nextNzbget.completedPath.trim() : "";
        integrations.nzbget = nextNzbget;
      }
      if (integrations?.slskd) {
        const nextSlskd = {
          ...(currentSettings.integrations?.slskd || {}),
          ...integrations.slskd,
        };
        const trimmedUrl = String(nextSlskd.url || "").trim();
        if (trimmedUrl) {
          const urlValidation = validateExternalUrl(trimmedUrl);
          if (!urlValidation.valid) {
            return res.status(400).json({
              error: `Invalid slskd URL: ${urlValidation.error}`,
            });
          }
          nextSlskd.url = urlValidation.url.replace(/\/+$/, "");
        } else {
          nextSlskd.url = "";
        }
        nextSlskd.apiKey = typeof nextSlskd.apiKey === "string" ? nextSlskd.apiKey.trim() : "";
        nextSlskd.enabled = nextSlskd.enabled === true;
        const priority = Number.parseInt(nextSlskd.priority, 10);
        nextSlskd.priority = Number.isFinite(priority) ? Math.min(1000, Math.max(1, priority)) : 10;
        nextSlskd.cleanupAfterRuns = nextSlskd.cleanupAfterRuns === true;
        integrations.slskd = nextSlskd;
      }
      if (integrations?.sabnzbd) {
        const nextSabnzbd = {
          ...(currentSettings.integrations?.sabnzbd || {}),
          ...integrations.sabnzbd,
        };
        const trimmedUrl = String(nextSabnzbd.url || "").trim();
        if (trimmedUrl) {
          const urlValidation = validateExternalUrl(trimmedUrl);
          if (!urlValidation.valid) {
            return res.status(400).json({
              error: `Invalid SABnzbd URL: ${urlValidation.error}`,
            });
          }
          nextSabnzbd.url = urlValidation.url.replace(/\/+$/, "");
        } else {
          nextSabnzbd.url = "";
        }
        nextSabnzbd.apiKey =
          typeof nextSabnzbd.apiKey === "string" ? nextSabnzbd.apiKey.trim() : "";
        nextSabnzbd.enabled = nextSabnzbd.enabled === true;
        nextSabnzbd.category = String(nextSabnzbd.category || "aurral").trim() || "aurral";
        nextSabnzbd.deleteLeftovers = nextSabnzbd.deleteLeftovers !== false;
        const priority = Number.parseInt(nextSabnzbd.priority, 10);
        nextSabnzbd.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 20;
        nextSabnzbd.addPaused = nextSabnzbd.addPaused === true;
        integrations.sabnzbd = nextSabnzbd;
      }
      if (integrations?.deemix) {
        const nextDeemix = {
          ...(currentSettings.integrations?.deemix || {}),
          ...integrations.deemix,
        };
        const trimmedUrl = String(nextDeemix.url || "").trim();
        if (trimmedUrl) {
          const urlValidation = validateExternalUrl(trimmedUrl);
          if (!urlValidation.valid) {
            return res.status(400).json({
              error: `Invalid deemix URL: ${urlValidation.error}`,
            });
          }
          nextDeemix.url = urlValidation.url.replace(/\/+$/, "");
        } else {
          nextDeemix.url = "";
        }
        nextDeemix.enabled = nextDeemix.enabled === true;
        const bitrate = Number.parseInt(nextDeemix.bitrate, 10);
        nextDeemix.bitrate = [1, 3, 9].includes(bitrate) ? bitrate : 9;
        const priority = Number.parseInt(nextDeemix.priority, 10);
        nextDeemix.priority = Number.isFinite(priority)
          ? Math.min(1000, Math.max(1, priority))
          : 15;
        integrations.deemix = nextDeemix;
      }
      if (integrations?.ytdlp) {
        const nextYtdlp = {
          ...(currentSettings.integrations?.ytdlp || {}),
          ...integrations.ytdlp,
        };
        nextYtdlp.enabled = nextYtdlp.enabled !== false;
        const priority = Number.parseInt(nextYtdlp.priority, 10);
        nextYtdlp.priority = Number.isFinite(priority) ? Math.min(1000, Math.max(1, priority)) : 50;
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

      if (integrations?.google?.redirectUri !== undefined) {
        const trimmedRedirectUri = String(integrations.google.redirectUri).trim();
        if (trimmedRedirectUri) {
          const redirectValidation = validateExternalUrl(trimmedRedirectUri);
          if (!redirectValidation.valid) {
            return res.status(400).json({
              error: `Invalid Google redirect URI: ${redirectValidation.error}`,
            });
          }
          integrations.google.redirectUri = redirectValidation.url;
        } else {
          integrations.google.redirectUri = "";
        }
      }

      const INTEGRATION_KEYS = [
        "lidarr",
        "navidrome",
        "jellyfin",
        "slskd",
        "prowlarr",
        "nzbget",
        "sabnzbd",
        "ytdlp",
        "deemix",
        "lastfm",
        "ticketmaster",
        "news",
        "metadata",
        "general",
        "gotify",
        "webhookEvents",
        "google",
      ];
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
            configuredByUserId: req.user!.id,
          };
        }
        mergedIntegrations.webhooks =
          integrations.webhooks !== undefined ? integrations.webhooks : mergedIntegrations.webhooks;
      }

      if (mergedIntegrations?.coverArtArchive) {
        delete mergedIntegrations.coverArtArchive;
      }
      const normalizedSubsonic =
        subsonic && typeof subsonic === "object" && !Array.isArray(subsonic) ? subsonic : null;
      const updatedSettings = {
        ...currentSettings,
        dateTimeFormat:
          dateTimeFormat !== undefined
            ? dateTimeFormat
            : currentSettings.dateTimeFormat || defaultData.settings.dateTimeFormat,
        quality: quality !== undefined ? quality : currentSettings.quality || "standard",
        qualityProfile:
          qualityProfile !== undefined
            ? normalizeQualityProfile(
                qualityProfile &&
                  typeof qualityProfile === "object" &&
                  !Array.isArray(qualityProfile)
                  ? { ...currentSettings.qualityProfile, ...qualityProfile }
                  : qualityProfile,
                integrations?.slskd,
              )
            : currentSettings.qualityProfile,
        subsonic:
          normalizedSubsonic !== null
            ? {
                ...(currentSettings.subsonic || defaultData.settings.subsonic),
                ...normalizedSubsonic,
                favoriteAutoKeep:
                  normalizedSubsonic.favoriteAutoKeep !== undefined
                    ? normalizedSubsonic.favoriteAutoKeep !== false
                    : (currentSettings.subsonic || defaultData.settings.subsonic)
                        .favoriteAutoKeep !== false,
              }
            : currentSettings.subsonic || defaultData.settings.subsonic,
        rootFolderPath:
          rootFolderPath !== undefined ? rootFolderPath : currentSettings.rootFolderPath || null,
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
                      ...(currentSettings.security?.localNetworkBypass ||
                        defaultData.settings.security.localNetworkBypass),
                      ...security.localNetworkBypass,
                      enabled: security.localNetworkBypass.enabled === true,
                    }
                  : currentSettings.security?.localNetworkBypass ||
                    defaultData.settings.security.localNetworkBypass,
              }
            : currentSettings.security || defaultData.settings.security,
        missingTrackSearch:
          missingTrackSearch && typeof missingTrackSearch === "object"
            ? { ...currentSettings.missingTrackSearch, ...missingTrackSearch }
            : currentSettings.missingTrackSearch,
        reviewTimeoutHours:
          reviewTimeoutHours !== undefined
            ? reviewTimeoutHours
            : currentSettings.reviewTimeoutHours,
      };

      if (updatedSettings?.integrations?.coverArtArchive) {
        delete updatedSettings.integrations.coverArtArchive;
      }
      if (updatedSettings?.integrations?.musicbrainz) {
        delete updatedSettings.integrations.musicbrainz;
      }

      if (didLidarrConnectionChange(currentSettings, updatedSettings)) {
        updatedSettings.integrations = {
          ...updatedSettings.integrations,
          lidarr: {
            ...(updatedSettings.integrations?.lidarr || {}),
            rootFolderPath: null,
            rootFolderPaths: [],
          },
        };
      }

      const previousMusicDataSource = getMusicDataSourceName();
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const lidarrWasActive = lidarrClient.isConfigured();
      dbOps.updateSettings(updatedSettings);
      if (getMusicDataSourceName() !== previousMusicDataSource) {
        const { enqueueDiscoveryRefresh } =
          await import("../../../services/discovery/refreshScheduler.ts");
        enqueueDiscoveryRefresh({ reason: "music_data_source_changed", force: true });
      }
      lidarrClient.updateConfig();
      const lidarrActive = lidarrClient.isConfigured();
      if (didLidarrRootDiscoveryChange(currentSettings, updatedSettings) && lidarrActive) {
        try {
          await lidarrClient.getRootFolders({ forceRefresh: true });
        } catch (error) {
          logger.warn("settings", "Failed to refresh Lidarr root folders:", {
            message: asAppError(error)?.message,
          });
        }
      }
      if (lidarrActive !== lidarrWasActive) {
        const { scheduleLibraryScan } = await import("../../../services/libraryScanWorker.ts");
        scheduleLibraryScan({ includeLidarr: lidarrActive });
        if (!lidarrActive) {
          const { invalidateLidarrArtistCache } =
            await import("../../../services/libraryManager.ts");
          const { enqueueSystemTaskJob } = await import("../../../services/honkerDb.ts");
          invalidateLidarrArtistCache();
          enqueueSystemTaskJob({ kind: "lidarr-files-release" });
        }
      }
      const { downloadClientRegistry } =
        await import("../../../services/download/downloadClientSettings.ts");
      downloadClientRegistry.updateConfig(updatedSettings.integrations);
      try {
        const { refreshLibraryFileWatcher } =
          await import("../../../services/libraryFileWatcher.ts");
        await refreshLibraryFileWatcher();
      } catch (error) {
        logger.warn("settings", "Failed to refresh library file watcher:", {
          message: asAppError(error)?.message,
        });
      }
      if (
        qualityProfile !== undefined &&
        JSON.stringify(updatedSettings.qualityProfile) !==
          JSON.stringify(currentSettings.qualityProfile)
      ) {
        const { enqueueSystemTaskJob } = await import("../../../services/honkerDb.ts");
        enqueueSystemTaskJob({ kind: "quality-profile-refresh" }, { priority: -10 });
      }
      if (
        !isDeepStrictEqual(currentSettings.integrations?.news, updatedSettings.integrations?.news)
      ) {
        const { enqueueSystemTaskJob } = await import("../../../services/honkerDb.ts");
        enqueueSystemTaskJob({ kind: "news-refresh" });
      }
      const playbackSettingsChanged = ["navidrome", "jellyfin"].some(
        (key) =>
          !isDeepStrictEqual(
            currentSettings.integrations?.[key],
            updatedSettings.integrations?.[key],
          ),
      );
      if (playbackSettingsChanged) {
        const { playlistManager } = await import("../../../services/playlists/playlistManager.ts");
        playlistManager.updateConfig();
        try {
          playlistManager.scheduleScanLibrary(true);
        } catch (error) {
          logger.warn("settings", "Failed to queue Library scan:", {
            message: asAppError(error)?.message,
          });
        }
        try {
          playlistManager.requestPlaylistSync();
        } catch (error) {
          logger.warn("settings", "Failed to queue playback playlist sync:", {
            message: asAppError(error)?.message,
          });
        }
      }
      const reconciled = reconcileLocalNetworkBypassSetting().settings;
      if (localBypassWasEnabled && reconciled?.security?.localNetworkBypass?.enabled !== true) {
        websocketService.reconcileAuthState();
      }
      res.json({
        ...reconciled,
        rootWarnings: resolveLibraryRootWarnings(updatedSettings),
      });
    } catch (error) {
      logger.error("settings", "Settings POST error:", error ?? undefined);
      res
        .status(500)
        .json({ error: "Failed to save settings", message: asAppError(error)?.message });
    }
  });
}
