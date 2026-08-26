import express from "express";
import { dbOps, userOps } from "../db/helpers/index.js";
import { defaultData } from "../config/constants.js";
import { requirePasswordStrength, reconcileLocalNetworkBypassSetting } from "../middleware/auth.js";
import { validateDownloadFolderPath } from "../services/downloadFolderConfig.js";
import { logger } from "../services/logger.js";
import { testNavidromeConnection } from "./shared/navidromeTest.js";
import {
  testLidarrConnection as lidarrTest,
  fetchQualityProfiles,
  fetchMetadataProfiles,
} from "../services/lidarrSettingsService.js";
import { auth } from "../services/betterAuth.js";

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

router.get("/lidarr/profiles", async (req, res) => {
  try {
    const url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    const profiles = await fetchQualityProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: "Failed to fetch Lidarr quality profiles",
      message: error.message,
    });
  }
});

router.get("/lidarr/metadata-profiles", async (req, res) => {
  try {
    const url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    const profiles = await fetchMetadataProfiles({ url, apiKey });
    res.json(profiles);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: "Failed to fetch Lidarr metadata profiles",
      message: error.message,
    });
  }
});

router.get("/lidarr/test", async (req, res) => {
  try {
    const url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
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
  const url = String(lidarr.url || "").trim().replace(/\/+$/, "");
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
    const { auth: authInput, lidarr, security, downloadFolderPath } = req.body;
    const authName = String(authInput?.name || "").trim();
    const authEmail = String(authInput?.email || "").trim().toLowerCase();
    const authPassword = String(authInput?.password || "");
    if (!authName || !authEmail || !authPassword) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    const passwordValidation = requirePasswordStrength(authPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
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
      },
      lidarr: {
        ...(current.integrations?.lidarr || {}),
        ...lidarr,
        url: String(lidarr.url).trim().replace(/\/+$/, ""),
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

    if (userOps.countUsers() === 0) {
      await auth.api.signUpEmail({
        body: {
          name: authName,
          email: authEmail,
          password: authPassword,
          username: authEmail,
          displayUsername: authName,
          role: "admin",
        },
      });
    }
    const adminCandidate = userOps.getUserByUsername(authEmail);
    if (!adminCandidate) {
      throw new Error("Failed to create the administrator account");
    }
    if (adminCandidate.role !== "admin" && !userOps.updateUser(adminCandidate.id, { role: "admin" })) {
      throw new Error("Failed to create the administrator account");
    }

    dbOps.updateSettings(nextSettings);

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
