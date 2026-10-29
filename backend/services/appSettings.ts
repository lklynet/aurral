import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";
import { dbOps } from "../db/helpers/index.ts";
import { MAX_REVIEW_TIMEOUT_HOURS } from "../db/helpers/settings.ts";
import type { AppSettings, StoredIntegrations } from "../db/helpers/settings.ts";
import { DATE_TIME_FORMATS, DEFAULT_METADATA_BASE_URL, defaultData } from "../config/constants.ts";
import { reconcileLocalNetworkBypassSetting } from "../middleware/auth.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { websocketService } from "./websocketService.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import {
  resolveYtdlpStagingRoot,
  validateDownloadFolderPath,
  computeLibraryRootOverlaps,
  getOverlapCheckedLidarrRoots,
} from "./downloadFolderConfig.ts";
import { normalizePathMappings } from "./pathMappings.ts";
import { readOnlyFolderOverlapping } from "./libraryFolders.ts";
import { logger } from "./logger.ts";
import { normalizeLidarrApiKey, normalizeLidarrUrl } from "./lidarrClient.ts";
import { getNewsSettings, normalizeNewsFeeds, normalizeNewsGroups } from "./apiClients/config.ts";
import { normalizeQualityProfile } from "./qualityProfileModel.ts";
import { getMusicDataSourceName } from "./musicDataSource/index.ts";
import { asAppError } from "../../lib/errors.ts";

const objectValue = v.record(v.string(), v.unknown());
const asObject = (value: unknown) => (v.is(objectValue, value) ? value : undefined);

export const appSettingsPatch = v.object({
  quality: v.optional(v.string()),
  qualityProfile: v.optional(v.unknown()),
  subsonic: v.optional(v.unknown()),
  releaseTypes: v.optional(v.array(v.string())),
  integrations: v.optional(objectValue),
  rootFolderPath: v.optional(v.nullable(v.string())),
  downloadFolderPath: v.optional(v.nullable(v.string())),
  pathMappings: v.optional(v.unknown()),
  security: v.optional(objectValue),
  missingTrackSearch: v.optional(v.unknown()),
  inbox: v.optional(objectValue),
  dateTimeFormat: v.optional(v.unknown()),
  reviewTimeoutHours: v.optional(v.unknown()),
});

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

function mergePlexIntegration(
  existing: StoredIntegrations["plex"] = {},
  input: StoredIntegrations["plex"] = {},
) {
  return {
    ...existing,
    ...input,
    token: input.token ?? existing.token ?? "",
    clientId: input.clientId ?? existing.clientId ?? "",
  };
}

function mergeIntegrations(existing: StoredIntegrations, input: StoredIntegrations) {
  const merged = { ...existing, ...input };
  for (const key of INTEGRATION_KEYS) {
    const patch = asObject(input[key]);
    merged[key] = patch ? { ...asObject(existing[key]), ...patch } : existing[key];
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

const clampedInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function readAppSettings() {
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
  return {
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
  };
}

function normalizeIntegrationPatch(
  integrations: StoredIntegrations,
  currentSettings: AppSettings,
): string | null {
  const lidarr = asObject(integrations.lidarr);
  if (lidarr?.externalUrl !== undefined) {
    const trimmedExternalUrl = String(lidarr.externalUrl).trim();
    if (trimmedExternalUrl) {
      const urlValidation = validateExternalUrl(trimmedExternalUrl);
      if (!urlValidation.valid) return urlValidation.error;
      lidarr.externalUrl = urlValidation.url;
    } else {
      lidarr.externalUrl = "";
    }
  }

  const metadata = asObject(integrations.metadata);
  if (metadata) {
    const nextMetadata = {
      ...(currentSettings.integrations?.metadata || {}),
      ...metadata,
    };
    nextMetadata.provider = "brainzmash";
    const baseUrlValidation = validateExternalUrl(nextMetadata.baseUrl || "");
    if (!baseUrlValidation.valid) {
      return `Invalid metadata base URL: ${baseUrlValidation.error}`;
    }
    nextMetadata.baseUrl = String(baseUrlValidation.url || "")
      .trim()
      .replace(/\/+$/, "");
    nextMetadata.userAgentSuffix =
      typeof nextMetadata.userAgentSuffix === "string" ? nextMetadata.userAgentSuffix.trim() : "";
    nextMetadata.enableNarrowFallbacks = nextMetadata.enableNarrowFallbacks !== false;
    integrations.metadata = nextMetadata;
  }
  const enabledLidarr = asObject(integrations.lidarr);
  if (enabledLidarr?.enabled !== undefined) {
    integrations.lidarr = {
      ...enabledLidarr,
      enabled: enabledLidarr.enabled === true,
    };
  }
  if (integrations.coverArtArchive) {
    delete integrations.coverArtArchive;
  }

  const prowlarr = asObject(integrations.prowlarr);
  if (prowlarr) {
    const nextProwlarr = {
      ...(currentSettings.integrations?.prowlarr || {}),
      ...prowlarr,
    };
    const trimmedUrl = String(nextProwlarr.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid Prowlarr URL: ${urlValidation.error}`;
      nextProwlarr.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextProwlarr.url = "";
    }
    nextProwlarr.enabled = nextProwlarr.enabled === true;
    nextProwlarr.apiKey = typeof nextProwlarr.apiKey === "string" ? nextProwlarr.apiKey.trim() : "";
    const categories: unknown = nextProwlarr.categories;
    nextProwlarr.categories = (
      Array.isArray(categories)
        ? categories.map((entry: unknown) => Number.parseInt(String(entry), 10))
        : String(categories || "")
            .split(",")
            .map((entry) => Number.parseInt(entry.trim(), 10))
    ).filter((entry) => Number.isFinite(entry) && entry > 0);
    if (nextProwlarr.categories.length === 0) {
      nextProwlarr.categories = [3000];
    }
    nextProwlarr.maxResults = clampedInteger(nextProwlarr.maxResults, 10, 200, 60);
    const indexers = asObject(nextProwlarr.indexers) ?? {};
    nextProwlarr.indexers = Object.fromEntries(
      Object.entries(indexers)
        .map(([id, value]): [string, { enabled: boolean; priority: number }] | null => {
          const parsedId = Number.parseInt(id, 10);
          if (!Number.isFinite(parsedId)) return null;
          const entry = asObject(value);
          return [
            String(parsedId),
            {
              enabled: entry?.enabled !== false,
              priority: clampedInteger(entry?.priority, 1, 1000, 25),
            },
          ];
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    );
    integrations.prowlarr = nextProwlarr;
  }

  const nzbget = asObject(integrations.nzbget);
  if (nzbget) {
    const nextNzbget = {
      ...(currentSettings.integrations?.nzbget || {}),
      ...nzbget,
    };
    const trimmedUrl = String(nextNzbget.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid NZBGet URL: ${urlValidation.error}`;
      nextNzbget.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextNzbget.url = "";
    }
    nextNzbget.enabled = nextNzbget.enabled === true;
    nextNzbget.username = typeof nextNzbget.username === "string" ? nextNzbget.username.trim() : "";
    nextNzbget.password = typeof nextNzbget.password === "string" ? nextNzbget.password : "";
    nextNzbget.category = String(nextNzbget.category || "aurral").trim() || "aurral";
    nextNzbget.priority = clampedInteger(nextNzbget.priority, 1, 1000, 20);
    nextNzbget.nzbPriority = clampedInteger(nextNzbget.nzbPriority, -100, 900, 0);
    nextNzbget.addPaused = nextNzbget.addPaused === true;
    nextNzbget.deleteLeftovers = nextNzbget.deleteLeftovers !== false;
    nextNzbget.completedPath =
      typeof nextNzbget.completedPath === "string" ? nextNzbget.completedPath.trim() : "";
    integrations.nzbget = nextNzbget;
  }

  const slskd = asObject(integrations.slskd);
  if (slskd) {
    const nextSlskd = {
      ...(currentSettings.integrations?.slskd || {}),
      ...slskd,
    };
    const trimmedUrl = String(nextSlskd.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid slskd URL: ${urlValidation.error}`;
      nextSlskd.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextSlskd.url = "";
    }
    nextSlskd.apiKey = typeof nextSlskd.apiKey === "string" ? nextSlskd.apiKey.trim() : "";
    nextSlskd.enabled = nextSlskd.enabled === true;
    nextSlskd.priority = clampedInteger(nextSlskd.priority, 1, 1000, 10);
    nextSlskd.cleanupAfterRuns = nextSlskd.cleanupAfterRuns === true;
    integrations.slskd = nextSlskd;
  }

  const sabnzbd = asObject(integrations.sabnzbd);
  if (sabnzbd) {
    const nextSabnzbd = {
      ...(currentSettings.integrations?.sabnzbd || {}),
      ...sabnzbd,
    };
    const trimmedUrl = String(nextSabnzbd.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid SABnzbd URL: ${urlValidation.error}`;
      nextSabnzbd.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextSabnzbd.url = "";
    }
    nextSabnzbd.apiKey = typeof nextSabnzbd.apiKey === "string" ? nextSabnzbd.apiKey.trim() : "";
    nextSabnzbd.enabled = nextSabnzbd.enabled === true;
    nextSabnzbd.category = String(nextSabnzbd.category || "aurral").trim() || "aurral";
    nextSabnzbd.deleteLeftovers = nextSabnzbd.deleteLeftovers !== false;
    nextSabnzbd.priority = clampedInteger(nextSabnzbd.priority, 1, 1000, 20);
    nextSabnzbd.addPaused = nextSabnzbd.addPaused === true;
    integrations.sabnzbd = nextSabnzbd;
  }

  const deemix = asObject(integrations.deemix);
  if (deemix) {
    const nextDeemix = {
      ...(currentSettings.integrations?.deemix || {}),
      ...deemix,
    };
    const trimmedUrl = String(nextDeemix.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid deemix URL: ${urlValidation.error}`;
      nextDeemix.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextDeemix.url = "";
    }
    nextDeemix.enabled = nextDeemix.enabled === true;
    const bitrate = Number.parseInt(String(nextDeemix.bitrate), 10);
    nextDeemix.bitrate = [1, 3, 9].includes(bitrate) ? bitrate : 9;
    nextDeemix.priority = clampedInteger(nextDeemix.priority, 1, 1000, 15);
    integrations.deemix = nextDeemix;
  }

  const ytdlp = asObject(integrations.ytdlp);
  if (ytdlp) {
    const nextYtdlp = {
      ...(currentSettings.integrations?.ytdlp || {}),
      ...ytdlp,
    };
    nextYtdlp.enabled = nextYtdlp.enabled !== false;
    nextYtdlp.priority = clampedInteger(nextYtdlp.priority, 1, 1000, 50);
    const stagingPath = resolveYtdlpStagingRoot(nextYtdlp.stagingPath);
    const validation = validateDownloadFolderPath(stagingPath, undefined, { create: true });
    if (!validation.valid) return `Invalid yt-dlp staging path: ${validation.error}`;
    nextYtdlp.stagingPath = validation.path;
    Reflect.deleteProperty(nextYtdlp, "binaryPath");
    Reflect.deleteProperty(nextYtdlp, "audioFormat");
    integrations.ytdlp = nextYtdlp;
  }

  const news = asObject(integrations.news);
  if (news) {
    const nextNews = {
      ...(currentSettings.integrations?.news || {}),
      ...news,
    };
    nextNews.enabled = nextNews.enabled !== false;
    nextNews.feeds = normalizeNewsFeeds(nextNews.feeds);
    nextNews.groups = normalizeNewsGroups(nextNews.groups);
    integrations.news = nextNews;
  }

  const google = asObject(integrations.google);
  if (google?.redirectUri !== undefined) {
    const trimmedRedirectUri = String(google.redirectUri).trim();
    if (trimmedRedirectUri) {
      const redirectValidation = validateExternalUrl(trimmedRedirectUri);
      if (!redirectValidation.valid) {
        return `Invalid Google redirect URI: ${redirectValidation.error}`;
      }
      google.redirectUri = redirectValidation.url;
    } else {
      google.redirectUri = "";
    }
  }
  return null;
}

export async function saveAppSettings(
  input: v.InferOutput<typeof appSettingsPatch>,
  userId: number,
) {
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
  } = input;

  if (
    dateTimeFormat !== undefined &&
    (typeof dateTimeFormat !== "string" || !DATE_TIME_FORMATS.includes(dateTimeFormat))
  ) {
    return { error: "Invalid date and time format" };
  }
  if (
    reviewTimeoutHours !== undefined &&
    (typeof reviewTimeoutHours !== "number" ||
      !Number.isInteger(reviewTimeoutHours) ||
      reviewTimeoutHours < 0 ||
      reviewTimeoutHours > MAX_REVIEW_TIMEOUT_HOURS)
  ) {
    return {
      error: `reviewTimeoutHours must be a whole number from 0 to ${MAX_REVIEW_TIMEOUT_HOURS}`,
    };
  }

  const readOnlyOverlap =
    typeof downloadFolderPath === "string" && downloadFolderPath.trim()
      ? readOnlyFolderOverlapping(downloadFolderPath.trim())
      : null;
  if (readOnlyOverlap) {
    return {
      error: `The Downloads Folder cannot overlap the read-only folder ${readOnlyOverlap}. Choose another folder, or remove the read-only folder in Settings → Library.`,
    };
  }

  const currentSettings = dbOps.getSettings();
  const localBypassWasEnabled = currentSettings?.security?.localNetworkBypass?.enabled === true;
  if (integrations) {
    const error = normalizeIntegrationPatch(integrations, currentSettings);
    if (error) return { error };
  }

  let mergedIntegrations: StoredIntegrations =
    currentSettings.integrations || defaultData.settings.integrations || {};
  if (integrations) {
    mergedIntegrations = mergeIntegrations(mergedIntegrations, integrations);
    // mergeIntegrations()'s top-level spread already clobbered .plex down to
    // whatever partial fields the client sent (it isn't in INTEGRATION_KEYS,
    // which is why "plex" gets its own encryption-aware merge) - merge
    // against the true pre-request value, not that already-corrupted one.
    const plex = asObject(integrations.plex);
    mergedIntegrations.plex = plex
      ? mergePlexIntegration(currentSettings.integrations?.plex, plex)
      : mergedIntegrations.plex;
    if (plex?.token && plex.token !== currentSettings.integrations?.plex?.token) {
      mergedIntegrations.plex = {
        ...mergedIntegrations.plex,
        configuredByUserId: userId,
      };
    }
  }

  if (mergedIntegrations?.coverArtArchive) {
    delete mergedIntegrations.coverArtArchive;
  }
  const normalizedSubsonic = Array.isArray(subsonic) ? undefined : asObject(subsonic);
  const currentSubsonic = currentSettings.subsonic || defaultData.settings.subsonic;
  const localNetworkBypass = asObject(security?.localNetworkBypass);
  const missingTrackSearchPatch = asObject(missingTrackSearch);
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
            qualityProfile && typeof qualityProfile === "object" && !Array.isArray(qualityProfile)
              ? { ...currentSettings.qualityProfile, ...qualityProfile }
              : qualityProfile,
            asObject(integrations?.slskd),
          )
        : currentSettings.qualityProfile,
    subsonic: normalizedSubsonic
      ? {
          ...currentSubsonic,
          ...normalizedSubsonic,
          favoriteAutoKeep:
            normalizedSubsonic.favoriteAutoKeep !== undefined
              ? normalizedSubsonic.favoriteAutoKeep !== false
              : currentSubsonic.favoriteAutoKeep !== false,
        }
      : currentSubsonic,
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
            localNetworkBypass: localNetworkBypass
              ? {
                  ...(currentSettings.security?.localNetworkBypass ||
                    defaultData.settings.security.localNetworkBypass),
                  ...localNetworkBypass,
                  enabled: localNetworkBypass.enabled === true,
                }
              : currentSettings.security?.localNetworkBypass ||
                defaultData.settings.security.localNetworkBypass,
          }
        : currentSettings.security || defaultData.settings.security,
    missingTrackSearch: missingTrackSearchPatch
      ? { ...currentSettings.missingTrackSearch, ...missingTrackSearchPatch }
      : currentSettings.missingTrackSearch,
    reviewTimeoutHours:
      reviewTimeoutHours !== undefined ? reviewTimeoutHours : currentSettings.reviewTimeoutHours,
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
  const { lidarrClient } = await import("./lidarrClient.ts");
  const lidarrWasActive = lidarrClient.isConfigured();
  dbOps.updateSettings(updatedSettings);
  if (getMusicDataSourceName() !== previousMusicDataSource) {
    const { enqueueDiscoveryRefresh } = await import("./discovery/refreshScheduler.ts");
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
    const { scheduleLibraryScan } = await import("./libraryScanWorker.ts");
    scheduleLibraryScan({ includeLidarr: lidarrActive });
    if (!lidarrActive) {
      const { invalidateLidarrArtistCache } = await import("./libraryManager.ts");
      const { enqueueSystemTaskJob } = await import("./honkerDb.ts");
      invalidateLidarrArtistCache();
      enqueueSystemTaskJob({ kind: "lidarr-files-release" });
    }
  }
  const { downloadClientRegistry } = await import("./download/downloadClientSettings.ts");
  downloadClientRegistry.updateConfig(updatedSettings.integrations);
  try {
    const { refreshLibraryFileWatcher } = await import("./libraryFileWatcher.ts");
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
    const { enqueueSystemTaskJob } = await import("./honkerDb.ts");
    enqueueSystemTaskJob({ kind: "quality-profile-refresh" }, { priority: -10 });
  }
  if (!isDeepStrictEqual(currentSettings.integrations?.news, updatedSettings.integrations?.news)) {
    const { enqueueSystemTaskJob } = await import("./honkerDb.ts");
    enqueueSystemTaskJob({ kind: "news-refresh" });
  }
  const playbackSettingsChanged = ["navidrome", "jellyfin"].some(
    (key) =>
      !isDeepStrictEqual(currentSettings.integrations?.[key], updatedSettings.integrations?.[key]),
  );
  if (playbackSettingsChanged) {
    const { playlistManager } = await import("./playlists/playlistManager.ts");
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
  return {
    settings: {
      ...reconciled,
      rootWarnings: resolveLibraryRootWarnings(updatedSettings),
    },
  };
}
