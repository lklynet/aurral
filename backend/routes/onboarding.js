import express from "express";
import { dbOps, userOps } from "../db/helpers/index.js";
import { hashPassword } from "../middleware/passwordHash.js";
import { defaultData } from "../config/constants.js";
import { requirePasswordStrength, reconcileLocalNetworkBypassSetting } from "../middleware/auth.js";
import { validateDownloadFolderPath } from "../services/downloadFolderConfig.js";
import { logger } from "../services/logger.js";
import { stripTrailingSlashes } from "../services/textUtils.js";
import { testNavidromeConnection } from "./shared/navidromeTest.js";
import {
  testLidarrConnection as lidarrTest,
  fetchQualityProfiles,
  fetchMetadataProfiles,
} from "../services/lidarrSettingsService.js";

const router = express.Router();

router.use((req, res, next) => {
  const settings = dbOps.getSettings();
  if (settings.onboardingComplete) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Onboarding has already been completed",
    });
  }
  next();
});

router.post("/lidarr/profiles", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const profiles = await fetchQualityProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: "Failed to fetch Lidarr quality profiles",
      message: error.message,
    });
  }
});

router.post("/lidarr/metadata-profiles", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const profiles = await fetchMetadataProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: "Failed to fetch Lidarr metadata profiles",
      message: error.message,
    });
  }
});

router.post("/lidarr/test", async (req, res) => {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const apiKey = String(req.body?.apiKey || "").trim();
    const result = await lidarrTest({ url, apiKey });
    if (result.connected) {
      res.json({ success: true, message: "Connection successful" });
    } else {
      res.status(400).json({ error: result.error || "Connection failed" });
    }
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: "Connection failed",
      message: error.message,
    });
  }
});

router.post("/navidrome/test", testNavidromeConnection);

async function resolveLidarrProfiles(lidarr) {
  let qualityProfileId =
    lidarr.qualityProfileId != null ? parseInt(lidarr.qualityProfileId, 10) || null : null;
  let metadataProfileId =
    lidarr.metadataProfileId != null ? parseInt(lidarr.metadataProfileId, 10) || null : null;
  if (qualityProfileId && metadataProfileId) {
    return { qualityProfileId, metadataProfileId };
  }
  const url = stripTrailingSlashes(String(lidarr.url || "").trim());
  const apiKey = String(lidarr.apiKey || "").trim();
  if (!url || !apiKey) return { qualityProfileId, metadataProfileId };
  try {
    const [qualityProfiles, metadataProfiles] = await Promise.all([
      qualityProfileId ? null : fetchQualityProfiles({ url, apiKey }),
      metadataProfileId ? null : fetchMetadataProfiles({ url, apiKey }),
    ]);
    if (!qualityProfileId && Array.isArray(qualityProfiles) && qualityProfiles[0]?.id != null) {
      qualityProfileId = parseInt(qualityProfiles[0].id, 10) || null;
    }
    if (!metadataProfileId && Array.isArray(metadataProfiles) && metadataProfiles[0]?.id != null) {
      metadataProfileId = parseInt(metadataProfiles[0].id, 10) || null;
    }
  } catch (error) {
    logger.warn("onboarding", "Could not auto-pick Lidarr profiles:", { message: error.message });
  }
  return { qualityProfileId, metadataProfileId };
}

router.post("/complete", async (req, res) => {
  try {
    const { authUser, authPassword, lidarr, security, downloadFolderPath } = req.body;
    if (authPassword != null && String(authPassword).length > 0) {
      const passwordValidation = requirePasswordStrength(authPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
    }

    if (!lidarr?.url || !lidarr?.apiKey) {
      return res.status(400).json({
        error: "Lidarr is required",
        message: "Connect Lidarr before finishing setup.",
      });
    }

    const current = dbOps.getSettings();
    const profiles = await resolveLidarrProfiles(lidarr);
    const integrations = {
      ...(current.integrations || defaultData.settings.integrations || {}),
      general: {
        ...(current.integrations?.general || {}),
        authUser:
          authUser != null
            ? String(authUser).trim()
            : current.integrations?.general?.authUser || "admin",
        authPassword:
          authPassword != null
            ? String(authPassword)
            : current.integrations?.general?.authPassword || "",
      },
      lidarr: {
        ...(current.integrations?.lidarr || {}),
        ...lidarr,
        url: stripTrailingSlashes(String(lidarr.url).trim()),
        apiKey: String(lidarr.apiKey).trim(),
        qualityProfileId: profiles.qualityProfileId,
        metadataProfileId: profiles.metadataProfileId,
        defaultMonitorOption:
          lidarr.defaultMonitorOption != null
            ? String(lidarr.defaultMonitorOption)
            : current.integrations?.lidarr?.defaultMonitorOption || "none",
        searchOnAdd: lidarr.searchOnAdd === true,
      },
    };

    const nextSettings = {
      ...current,
      integrations,
      onboardingComplete: true,
      security: {
        ...(current.security || defaultData.settings.security || {}),
        localNetworkBypass: {
          enabled: security?.localNetworkBypass?.enabled === true,
        },
      },
    };

    if (downloadFolderPath !== undefined && String(downloadFolderPath).trim()) {
      const validation = validateDownloadFolderPath(downloadFolderPath, undefined, {
        create: true,
      });
      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error,
          message: validation.error,
        });
      }
      nextSettings.downloadFolderPath = validation.path;
    }

    dbOps.updateSettings(nextSettings);

    const authUserFinal = integrations?.general?.authUser || "admin";
    const authPasswordFinal = integrations?.general?.authPassword || "";
    if (authPasswordFinal && userOps.getAllUsers().length === 0) {
      const hash = hashPassword(authPasswordFinal);
      userOps.createUser(authUserFinal, hash, "admin", null);
    }

    reconcileLocalNetworkBypassSetting();

    if (integrations?.lidarr?.apiKey) {
      const { enqueueDiscoveryRefresh } = await import(
        "../services/discovery/refreshScheduler.js"
      );
      enqueueDiscoveryRefresh({ reason: "onboarding" });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error("onboarding", "Complete error:", { message: error.message });
    res.status(500).json({
      error: "Failed to save onboarding",
      message: error.message,
    });
  }
});

export default router;
