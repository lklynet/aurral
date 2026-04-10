import express from "express";
import { dbOps } from "../config/db-helpers.js";
import { defaultData } from "../config/constants.js";
import { noCache } from "../middleware/cache.js";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

router.get("/", noCache, (req, res) => {
  try {
    const settings = dbOps.getSettings();
    res.json(settings);
  } catch (error) {
    console.error("Settings GET error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch settings", message: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { quality, releaseTypes, integrations } = req.body;

    const currentSettings = dbOps.getSettings();
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
        musicbrainz: integrations.musicbrainz
          ? {
              ...(mergedIntegrations.musicbrainz || {}),
              ...integrations.musicbrainz,
            }
          : mergedIntegrations.musicbrainz,
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

    const updatedSettings = {
      ...currentSettings,
      quality:
        quality !== undefined ? quality : currentSettings.quality || "standard",
      releaseTypes:
        releaseTypes !== undefined
          ? releaseTypes
          : currentSettings.releaseTypes || defaultData.settings.releaseTypes,
      integrations: mergedIntegrations,
    };

    dbOps.updateSettings(updatedSettings);
    res.json(updatedSettings);
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

    lidarrClient.updateConfig();
    const config = lidarrClient.getConfig();

    if (!config.url || !config.apiKey) {
      return res.status(400).json({
        error: "Lidarr not configured",
        message: "Please configure Lidarr URL and API key in settings first",
      });
    }

    const results = {
      qualityDefinitions: [],
      customFormats: [],
      releaseProfile: null,
      metadataProfile: null,
      namingConfig: null,
      qualityProfile: null,
      errors: [],
    };

    try {
      const qualityDefs = await lidarrClient.getQualityDefinitions();

      const flacDef = qualityDefs.find(
        (q) => q.quality?.name === "FLAC" || q.title === "FLAC",
      );
      const flac24Def = qualityDefs.find(
        (q) => q.quality?.name === "FLAC 24bit" || q.title === "FLAC 24bit",
      );

      if (flacDef) {
        const updated = await lidarrClient.updateQualityDefinition(flacDef.id, {
          ...flacDef,
          minSize: 0,
          maxSize: 1400,
          preferredSize: 895,
        });
        results.qualityDefinitions.push({
          name: "FLAC",
          updated: { min: 0, max: 1400, preferred: 895 },
        });
      }

      if (flac24Def) {
        const updated = await lidarrClient.updateQualityDefinition(
          flac24Def.id,
          {
            ...flac24Def,
            minSize: 0,
            maxSize: 1495,
            preferredSize: 895,
          },
        );
        results.qualityDefinitions.push({
          name: "FLAC 24bit",
          updated: { min: 0, max: 1495, preferred: 895 },
        });
      }

      const customFormats = [
        {
          name: "Preferred Groups",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "DeVOiD",
              implementation: "ReleaseGroupSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bDeVOiD\\b" },
            },
            {
              name: "PERFECT",
              implementation: "ReleaseGroupSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bPERFECT\\b" },
            },
            {
              name: "ENRiCH",
              implementation: "ReleaseGroupSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bENRiCH\\b" },
            },
          ],
        },
        {
          name: "CD",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "CD",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bCD\\b" },
            },
          ],
        },
        {
          name: "WEB",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "WEB",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bWEB\\b" },
            },
          ],
        },
        {
          name: "Lossless",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "Flac",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: false,
              fields: { value: "\\blossless\\b" },
            },
          ],
        },
        {
          name: "Vinyl",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              name: "Vinyl",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: false,
              fields: { value: "\\bVinyl\\b" },
            },
          ],
        },
      ];

      const toFieldArray = (fields) => {
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
          return fields;
        }
        return Object.entries(fields)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([name, value]) => ({ name, value }));
      };

      const flattenFields = (fields) => {
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
          return {};
        }
        return Object.fromEntries(
          Object.entries(fields).filter(
            ([, value]) => value !== undefined && value !== null,
          ),
        );
      };

      const buildCustomFormatPayloadVariants = (format) => {
        const base = JSON.parse(JSON.stringify(format));
        const variants = [base];

        const withFieldArray = {
          ...base,
          specifications: Array.isArray(base.specifications)
            ? base.specifications.map((spec) => ({
                ...spec,
                fields: toFieldArray(spec?.fields),
              }))
            : base.specifications,
        };
        variants.push(withFieldArray);

        const withFlattenedFields = {
          ...base,
          specifications: Array.isArray(base.specifications)
            ? base.specifications.map((spec) => {
                const fields = flattenFields(spec?.fields);
                const normalizedSpec = { ...spec, ...fields };
                delete normalizedSpec.fields;
                return normalizedSpec;
              })
            : base.specifications,
        };
        variants.push(withFlattenedFields);

        const seen = new Set();
        return variants.filter((variant) => {
          const key = JSON.stringify(variant);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const createCustomFormatWithFallback = async (format) => {
        const payloads = buildCustomFormatPayloadVariants(format);
        let lastError = null;

        for (const payload of payloads) {
          try {
            return await lidarrClient.createCustomFormat(payload);
          } catch (err) {
            lastError = err;
            const message = String(err?.message || "");
            const isBadRequest =
              message.includes("400 Bad Request") ||
              message.includes("Lidarr API error: 400");
            if (!isBadRequest) {
              throw err;
            }
          }
        }

        throw lastError || new Error("Failed to create custom format");
      };

      const existingFormats = await lidarrClient.getCustomFormats();
      for (const format of customFormats) {
        const existing = existingFormats.find((f) => f.name === format.name);
        if (!existing) {
          try {
            const created = await createCustomFormatWithFallback(format);
            results.customFormats.push(created);
          } catch (err) {
            results.errors.push(
              `Failed to create custom format "${format.name}": ${err.message}`,
            );
          }
        } else {
          results.customFormats.push(existing);
        }
      }

      const releaseProfilePayload = {
        name: "Aurral - Single Track Rip Filter",
        enabled: true,
        required: [],
        ignored: ["CUE", "FLAC/CUE"],
        preferred: [],
        tags: [],
      };

      const existingReleaseProfiles = await lidarrClient.getReleaseProfiles();
      const normalizeReleaseName = (value) =>
        String(value || "")
          .trim()
          .toLowerCase();
      const hasIgnoredMatch = (profile, value) =>
        Array.isArray(profile?.ignored) &&
        profile.ignored
          .map((item) => String(item || "").toLowerCase())
          .includes(String(value || "").toLowerCase());
      const existingReleaseProfile = existingReleaseProfiles.find((profile) => {
        if (!profile) return false;
        if (
          normalizeReleaseName(profile.name) ===
          normalizeReleaseName(releaseProfilePayload.name)
        ) {
          return true;
        }
        return (
          hasIgnoredMatch(profile, "CUE") &&
          hasIgnoredMatch(profile, "FLAC/CUE")
        );
      });

      if (existingReleaseProfile) {
        const updatedReleaseProfile = await lidarrClient.updateReleaseProfile(
          existingReleaseProfile.id,
          {
            ...releaseProfilePayload,
            id: existingReleaseProfile.id,
          },
        );
        results.releaseProfile = {
          id: updatedReleaseProfile.id,
          name: updatedReleaseProfile.name,
          updated: true,
        };
      } else {
        const createdReleaseProfile = await lidarrClient.createReleaseProfile(
          releaseProfilePayload,
        );
        results.releaseProfile = {
          id: createdReleaseProfile.id,
          name: createdReleaseProfile.name,
        };
      }

      const metadataProfiles = await lidarrClient.getMetadataProfiles();
      const aurralMetadataProfile = metadataProfiles.find(
        (profile) => profile.name === "Aurral - Standard",
      );
      const standardProfile = metadataProfiles.find(
        (profile) => profile.name === "Standard",
      );
      const baseMetadataProfile =
        aurralMetadataProfile || standardProfile || metadataProfiles[0];

      if (!baseMetadataProfile) {
        throw new Error("No metadata profiles available in Lidarr");
      }

      const desiredPrimaryTypes = ["Album", "EP", "Single"];
      const desiredSecondaryTypes = [
        "Studio",
        "Soundtrack",
        "Remix",
        "DJ-mix",
        "Compilation",
      ];

      const normalizeTypeName = (value) =>
        String(value || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      const getTypeName = (item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.name === "string") return item.name;
        if (typeof item.value === "string") return item.value;
        if (typeof item.albumType?.name === "string")
          return item.albumType.name;
        return "";
      };

      const applyTypeSelection = (available, desired) => {
        if (!Array.isArray(available) || available.length === 0) {
          return desired.map((name) => ({ name, allowed: true }));
        }
        const desiredSet = new Set(
          desired.map((name) => normalizeTypeName(name)),
        );
        return available.map((item) => {
          const itemName = getTypeName(item);
          const allowed = desiredSet.has(normalizeTypeName(itemName));
          if (typeof item === "string") {
            return { name: item, allowed };
          }
          return { ...item, allowed };
        });
      };

      const metadataProfilePayload = {
        ...baseMetadataProfile,
        name: "Aurral - Standard",
        primaryAlbumTypes: applyTypeSelection(
          baseMetadataProfile.primaryAlbumTypes,
          desiredPrimaryTypes,
        ),
        secondaryAlbumTypes: applyTypeSelection(
          baseMetadataProfile.secondaryAlbumTypes,
          desiredSecondaryTypes,
        ),
      };

      if (aurralMetadataProfile) {
        const updatedMetadataProfile = await lidarrClient.updateMetadataProfile(
          aurralMetadataProfile.id,
          metadataProfilePayload,
        );
        results.metadataProfile = {
          id: updatedMetadataProfile.id,
          name: updatedMetadataProfile.name,
          updated: true,
        };
      } else {
        const { id, ...createPayload } = metadataProfilePayload;
        const createdMetadataProfile =
          await lidarrClient.createMetadataProfile(createPayload);
        results.metadataProfile = {
          id: createdMetadataProfile.id,
          name: createdMetadataProfile.name,
        };
      }

      const namingConfig = await lidarrClient.getNamingConfig();
      const updatedNamingConfig = {
        ...namingConfig,
        renameTracks: true,
        replaceIllegalCharacters: true,
        standardTrackFormat:
          "{Album Title} {(Album Disambiguation)}/{Artist Name}_{Album Title}_{track:00}_{Track Title}",
        multiDiscTrackFormat:
          "{Album Title} {(Album Disambiguation)}/{Artist Name}_{Album Title}_{medium:00}-{track:00}_{Track Title}",
        artistFolderFormat: "{Artist Name}",
      };

      await lidarrClient.updateNamingConfig(updatedNamingConfig);
      results.namingConfig = updatedNamingConfig;

      const existingProfiles = await lidarrClient.getQualityProfiles();
      let aurralProfile = existingProfiles.find(
        (profile) => profile.name === "Aurral - HQ",
      );
      const baseProfile = aurralProfile || existingProfiles[0];

      if (!baseProfile) {
        throw new Error("No quality profiles available in Lidarr");
      }

      const selectedQualityNames = ["MP3-320", "FLAC"];
      const baseItems = JSON.parse(JSON.stringify(baseProfile.items || []));
      const qualityItemMap = new Map();

      const collectQualityItems = (items) => {
        for (const item of items) {
          if (item?.quality?.name) {
            qualityItemMap.set(item.quality.name, item);
          }
          if (Array.isArray(item.items)) {
            collectQualityItems(item.items);
          }
        }
      };

      collectQualityItems(baseItems);

      const qualityDefItems = (qualityDefs || []).map((definition) => ({
        id: definition.id,
        name: definition.title || definition.quality?.name,
        quality: {
          id: definition.quality?.id,
          name: definition.quality?.name || definition.title,
        },
        allowed: false,
        items: [],
      }));

      for (const defItem of qualityDefItems) {
        if (
          defItem.quality?.name &&
          !qualityItemMap.has(defItem.quality.name)
        ) {
          qualityItemMap.set(defItem.quality.name, defItem);
        }
      }

      const normalizeQualityItem = (item, allowed) => ({
        ...item,
        allowed,
        items: [],
      });

      const selectedItems = selectedQualityNames
        .map((name) => qualityItemMap.get(name))
        .filter(Boolean)
        .map((item) => normalizeQualityItem(item, true));

      const otherItems = Array.from(qualityItemMap.entries())
        .filter(([name]) => !selectedQualityNames.includes(name))
        .map(([, item]) => normalizeQualityItem(item, false));

      const profileItems = [...otherItems, ...selectedItems];
      const flacQualityId = qualityItemMap.get("FLAC")?.quality?.id;

      const formatItems = results.customFormats.map((cf) => {
        const scores = {
          "Preferred Groups": 10,
          CD: 2,
          WEB: 1,
          Lossless: 1,
          Vinyl: -5,
        };
        return {
          format: cf.id,
          name: cf.name,
          score: scores[cf.name] || 0,
        };
      });

      if (formatItems.length === 0) {
        results.errors.push(
          "No custom formats were created; quality profile minFormatScore set to 0.",
        );
      }

      const profileData = {
        ...baseProfile,
        name: "Aurral - HQ",
        upgradeAllowed: true,
        cutoff: flacQualityId ?? baseProfile.cutoff,
        items: profileItems,
        minFormatScore: formatItems.length > 0 ? 1 : 0,
        cutoffFormatScore: 0,
        formatItems,
      };

      if (!aurralProfile) {
        const { id, ...createPayload } = profileData;
        aurralProfile = await lidarrClient.createQualityProfile(createPayload);
        results.qualityProfile = {
          id: aurralProfile.id,
          name: aurralProfile.name,
        };
      } else {
        const updatedProfile = await lidarrClient.updateQualityProfile(
          aurralProfile.id,
          profileData,
        );
        results.qualityProfile = {
          id: updatedProfile.id,
          name: updatedProfile.name,
          updated: true,
        };
      }

      const currentSettings = dbOps.getSettings();
      dbOps.updateSettings({
        ...currentSettings,
        integrations: {
          ...currentSettings.integrations,
          lidarr: {
            ...(currentSettings.integrations?.lidarr || {}),
            qualityProfileId: aurralProfile.id,
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
        partialResults: results,
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
