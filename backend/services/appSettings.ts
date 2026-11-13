import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";
import { dbOps } from "../db/helpers/index.ts";
import { readIntegrationSettings } from "../db/helpers/integrationSettings.ts";
import type { AppSettings, StoredIntegrations } from "../db/helpers/settings.ts";
import { DATE_TIME_FORMATS, defaultData } from "../config/constants.ts";
import { reconcileLocalNetworkBypassSetting } from "./auth.ts";
import { validateExternalUrl } from "./urlValidator.ts";
import { websocketService } from "./websocketService.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { resolveYtdlpStagingRoot, validateDownloadFolderPath } from "./downloadFolderConfig.ts";
import { normalizePathMappings } from "./pathMappings.ts";
import { isUsenetClientKey, type UsenetClientKey } from "./usenetClientCommon.ts";
import { readOnlyFolderOverlapping } from "./libraryFolders.ts";
import { scheduleLibraryScan } from "./libraryScanWorker.ts";
import { logger } from "./logger.ts";
import { getNewsSettings, normalizeNewsFeeds, normalizeNewsGroups } from "./apiClients/config.ts";
import { normalizeQualityProfile } from "./qualityProfileModel.ts";
import { getMusicDataSourceName } from "./musicDataSource/index.ts";
import { asAppError } from "../../lib/errors.ts";
import { enqueueDiscoveryRefresh } from "./discovery/refreshScheduler.ts";
import { downloadClientRegistry } from "./download/downloadClientSettings.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";

const objectValue = v.record(v.string(), v.unknown());
const asObject = (value: unknown) => (v.is(objectValue, value) ? value : undefined);

export const appSettingsPatch = v.object({
  qualityProfile: v.optional(v.unknown()),
  integrations: v.optional(objectValue),
  downloadFolderPath: v.optional(v.nullable(v.string())),
  pathMappings: v.optional(v.unknown()),
  security: v.optional(objectValue),
  inbox: v.optional(objectValue),
  dateTimeFormat: v.optional(v.unknown()),
});

const INTEGRATION_KEYS = [
  "slskd",
  "prowlarr",
  "nzbget",
  "sabnzbd",
  "tidarr",
  "qbittorrent",
  "ytdlp",
  "deemix",
  "lastfm",
  "ticketmaster",
  "news",
  "metadata",
  "general",
  "gotify",
  "google",
];

function mergeIntegrations(existing: StoredIntegrations, input: StoredIntegrations) {
  const merged = { ...existing, ...input };
  for (const key of INTEGRATION_KEYS) {
    const patch = asObject(input[key]);
    merged[key] = patch ? { ...asObject(existing[key]), ...patch } : existing[key];
  }
  return merged;
}

const clampedInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const optionalPriority = (value: unknown) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(1, parsed)) : undefined;
};

export function readAppSettings() {
  const settings = dbOps.getSettings();
  if (settings?.integrations?.musicbrainz) {
    delete settings.integrations.musicbrainz;
  }
  settings.integrations.metadata = {
    baseUrl: String(settings.integrations.metadata?.baseUrl || "")
      .trim()
      .replace(/\/+$/, ""),
  };
  settings.security = {
    ...(settings.security || {}),
    localNetworkBypass: {
      enabled: settings?.security?.localNetworkBypass?.enabled === true,
    },
  };
  return {
    ...settings,
    downloadFolderPath: settings.downloadFolderPath || resolveDownloadRoot(),
    integrations: {
      ...(settings.integrations || {}),
      news: getNewsSettings(),
      ytdlp: {
        ...(settings.integrations?.ytdlp || {}),
        stagingPath: resolveYtdlpStagingRoot(settings.integrations?.ytdlp?.stagingPath),
      },
    },
  };
}

function isReadableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeIntegrationPatch(
  integrations: StoredIntegrations,
  currentSettings: AppSettings,
): string | null {
  const metadata = asObject(integrations.metadata);
  if (metadata) {
    const nextMetadata = {
      ...(currentSettings.integrations?.metadata || {}),
      ...metadata,
    };
    const trimmedBaseUrl = String(nextMetadata.baseUrl || "").trim();
    if (trimmedBaseUrl) {
      const baseUrlValidation = validateExternalUrl(trimmedBaseUrl);
      if (!baseUrlValidation.valid) {
        return `Invalid metadata base URL: ${baseUrlValidation.error}`;
      }
      nextMetadata.baseUrl = baseUrlValidation.url.replace(/\/+$/, "");
    } else {
      nextMetadata.baseUrl = "";
    }
    integrations.metadata = nextMetadata;
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
    const indexers = asObject(nextProwlarr.indexers) ?? {};
    nextProwlarr.indexers = Object.fromEntries(
      Object.entries(indexers)
        .map(
          ([id, value]):
            | [string, { enabled: boolean; priority: number; downloadClient?: UsenetClientKey }]
            | null => {
            const parsedId = Number.parseInt(id, 10);
            if (!Number.isFinite(parsedId)) return null;
            const entry = asObject(value);
            const downloadClient = entry?.downloadClient;
            return [
              String(parsedId),
              {
                enabled: entry?.enabled !== false,
                priority: clampedInteger(entry?.priority, 1, 1000, 25),
                ...(isUsenetClientKey(downloadClient) && { downloadClient }),
              },
            ];
          },
        )
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
    nextNzbget.albumPriority = optionalPriority(nextNzbget.albumPriority);
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
    nextSlskd.albumPriority = optionalPriority(nextSlskd.albumPriority);
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
    nextSabnzbd.priority = clampedInteger(nextSabnzbd.priority, 1, 1000, 20);
    nextSabnzbd.albumPriority = optionalPriority(nextSabnzbd.albumPriority);
    integrations.sabnzbd = nextSabnzbd;
  }

  const tidarr = asObject(integrations.tidarr);
  if (tidarr) {
    const nextTidarr = {
      ...(currentSettings.integrations?.tidarr || {}),
      ...tidarr,
    };
    const trimmedUrl = String(nextTidarr.url || "").trim();
    if (trimmedUrl) {
      const urlValidation = validateExternalUrl(trimmedUrl);
      if (!urlValidation.valid) return `Invalid Tidarr URL: ${urlValidation.error}`;
      nextTidarr.url = urlValidation.url.replace(/\/+$/, "");
    } else {
      nextTidarr.url = "";
    }
    nextTidarr.apiKey = typeof nextTidarr.apiKey === "string" ? nextTidarr.apiKey.trim() : "";
    nextTidarr.enabled = nextTidarr.enabled === true;
    nextTidarr.priority = clampedInteger(nextTidarr.priority, 1, 1000, 20);
    nextTidarr.albumPriority = optionalPriority(nextTidarr.albumPriority);
    integrations.tidarr = nextTidarr;
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
    nextDeemix.albumPriority = optionalPriority(nextDeemix.albumPriority);
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
    const cookiesPath = String(nextYtdlp.cookiesPath || "").trim();
    nextYtdlp.cookiesPath = cookiesPath;
    if (
      cookiesPath &&
      cookiesPath !== currentSettings.integrations?.ytdlp?.cookiesPath &&
      !isReadableFile(cookiesPath)
    ) {
      return `Cannot read the yt-dlp cookies file ${nextYtdlp.cookiesPath}`;
    }
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

export async function saveAppSettings(input: v.InferOutput<typeof appSettingsPatch>) {
  const {
    qualityProfile,
    integrations,
    downloadFolderPath,
    pathMappings,
    security,
    inbox,
    dateTimeFormat,
  } = input;

  if (
    dateTimeFormat !== undefined &&
    (typeof dateTimeFormat !== "string" || !DATE_TIME_FORMATS.includes(dateTimeFormat))
  ) {
    return { error: "Invalid date and time format" };
  }

  const libraryFolder = path.resolve(resolveDownloadRoot());
  const requestedFolder = typeof downloadFolderPath === "string" ? downloadFolderPath.trim() : "";
  const readOnlyOverlap =
    requestedFolder && path.resolve(requestedFolder) !== libraryFolder
      ? readOnlyFolderOverlapping(requestedFolder)
      : null;
  if (readOnlyOverlap) {
    return {
      error: `The Library folder cannot overlap the read-only folder ${readOnlyOverlap}. Choose another folder, or remove the read-only folder in Settings → Library.`,
    };
  }

  const currentSettings = dbOps.getSettings();
  const newsBefore = getNewsSettings();
  const localBypassWasEnabled = currentSettings?.security?.localNetworkBypass?.enabled === true;
  if (integrations) {
    const error = normalizeIntegrationPatch(integrations, currentSettings);
    if (error) return { error };
  }

  let mergedIntegrations: StoredIntegrations =
    currentSettings.integrations || defaultData.settings.integrations || {};
  if (integrations) {
    mergedIntegrations = mergeIntegrations(mergedIntegrations, integrations);
  }

  const { unreadable } = readIntegrationSettings(mergedIntegrations);
  if (unreadable.length) {
    return { error: `Aurral can't save these integration settings: ${unreadable.join(", ")}` };
  }
  const localNetworkBypass = asObject(security?.localNetworkBypass);
  const updatedSettings = {
    ...currentSettings,
    dateTimeFormat:
      dateTimeFormat !== undefined
        ? dateTimeFormat
        : currentSettings.dateTimeFormat || defaultData.settings.dateTimeFormat,
    qualityProfile:
      qualityProfile !== undefined
        ? normalizeQualityProfile(
            qualityProfile && typeof qualityProfile === "object" && !Array.isArray(qualityProfile)
              ? { ...currentSettings.qualityProfile, ...qualityProfile }
              : qualityProfile,
            asObject(integrations?.slskd),
          )
        : currentSettings.qualityProfile,
    downloadFolderPath:
      downloadFolderPath !== undefined
        ? downloadFolderPath
        : currentSettings.downloadFolderPath || null,
    pathMappings:
      pathMappings !== undefined
        ? normalizePathMappings(pathMappings)
        : currentSettings.pathMappings || [],
    integrations: mergedIntegrations,
    inbox:
      inbox !== undefined
        ? {
            ...(currentSettings.inbox || defaultData.settings.inbox),
            ...inbox,
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
  };

  if (updatedSettings?.integrations?.musicbrainz) {
    delete updatedSettings.integrations.musicbrainz;
  }

  const previousMusicDataSource = getMusicDataSourceName();
  dbOps.updateSettings(updatedSettings);
  if (getMusicDataSourceName() !== previousMusicDataSource) {
    enqueueDiscoveryRefresh({ reason: "music_data_source_changed", force: true });
  }
  downloadClientRegistry.updateConfig(updatedSettings.integrations);
  if (path.resolve(resolveDownloadRoot()) !== libraryFolder) scheduleLibraryScan();
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
    enqueueSystemTask({ kind: "quality-profile-refresh" }, { priority: -10 });
  }
  if (!isDeepStrictEqual(newsBefore, getNewsSettings())) {
    enqueueSystemTask({ kind: "news-refresh" });
  }
  const reconciled = reconcileLocalNetworkBypassSetting().settings;
  if (localBypassWasEnabled && reconciled?.security?.localNetworkBypass?.enabled !== true) {
    websocketService.reconcileAuthState();
  }
  return { settings: reconciled };
}
