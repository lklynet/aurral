import express from "express";
import bcrypt from "bcrypt";
import { dbOps, userOps } from "../config/db-helpers.js";
import { getDefaultListenHistoryProfile } from "../services/listeningHistory.js";
import {
  DEFAULT_METADATA_BASE_URL,
  LEGACY_METADATA_BASE_URL,
  defaultData,
} from "../config/constants.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { requirePasswordStrength } from "../middleware/validation.js";
import {
  getSuggestedDownloadFolderPath,
  validateDownloadFolderPath,
} from "../services/downloadFolderConfig.js";

const router = express.Router();

function normalizeMetadataBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  return trimmed === LEGACY_METADATA_BASE_URL ? DEFAULT_METADATA_BASE_URL : trimmed;
}

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

router.get("/lidarr/test-library-access", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    const { validateLidarrTestCredentials, withTemporaryLidarrClient } =
      await import("../services/lidarrTestSession.js");
    const { runLidarrLibraryAccessTest } =
      await import("../services/lidarrLibraryAccessTest.js");

    let url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    const validation = validateLidarrTestCredentials(url, apiKey);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    url = validation.url;

    const result = await withTemporaryLidarrClient(url, apiKey, (client) =>
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
    res.status(400).json({
      error: "Library access check failed",
      message: error.message,
    });
  }
});

router.get("/lidarr/profiles", async (req, res) => {
  try {
    const { validateLidarrTestCredentials, withTemporaryLidarrClient } =
      await import("../services/lidarrTestSession.js");

    let url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    const validation = validateLidarrTestCredentials(url, apiKey);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    url = validation.url;

    const profiles = await withTemporaryLidarrClient(url, apiKey, (client) =>
      client.getQualityProfiles(true),
    );

    res.json(profiles);
  } catch (error) {
    res.status(400).json({
      error: "Failed to fetch Lidarr quality profiles",
      message: error.message,
    });
  }
});

router.get("/lidarr/metadata-profiles", async (req, res) => {
  try {
    const { validateLidarrTestCredentials, withTemporaryLidarrClient } =
      await import("../services/lidarrTestSession.js");

    let url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    const validation = validateLidarrTestCredentials(url, apiKey);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    url = validation.url;

    const profiles = await withTemporaryLidarrClient(url, apiKey, (client) =>
      client.getMetadataProfiles(true),
    );

    res.json(profiles);
  } catch (error) {
    res.status(400).json({
      error: "Failed to fetch Lidarr metadata profiles",
      message: error.message,
    });
  }
});

router.get("/lidarr/test", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    let url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.query.apiKey || "").trim();
    if (!url || !apiKey) {
      return res.status(400).json({ error: "URL and API key are required" });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;
    const originalConfig = { ...lidarrClient.config };
    const originalApiPath = lidarrClient.apiPath;
    lidarrClient.config = { url, apiKey };
    lidarrClient.apiPath = "/api/v1";
    try {
      const result = await lidarrClient.testConnection(true);
      if (result.connected) {
        res.json({ success: true, message: "Connection successful" });
      } else {
        res.status(400).json({ error: result.error || "Connection failed" });
      }
    } finally {
      lidarrClient.config = originalConfig;
      lidarrClient.apiPath = originalApiPath;
    }
  } catch (error) {
    res.status(400).json({
      error: "Connection failed",
      message: error.message,
    });
  }
});

router.post("/navidrome/test", async (req, res) => {
  try {
    const { NavidromeClient } = await import("../services/navidrome.js");
    let url = (req.body?.url || "").trim().replace(/\/+$/, "");
    const username = (req.body?.username || "").trim();
    const password = req.body?.password ?? "";
    if (!url || !username || !password) {
      return res.status(400).json({
        error: "URL, username, and password are required",
      });
    }
    const urlValidation = validateExternalUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }
    url = urlValidation.url;
    const client = new NavidromeClient(url, username, password);
    await client.ping();
    res.json({ success: true, message: "Connection successful" });
  } catch (error) {
    res.status(400).json({
      error: "Connection failed",
      message: error.message,
    });
  }
});

router.post("/lidarr/apply-community-guide", async (req, res) => {
  try {
    const { applyLidarrCommunityGuide } =
      await import("../services/lidarrCommunityGuide.js");
    const { validateLidarrTestCredentials, withTemporaryLidarrClient } =
      await import("../services/lidarrTestSession.js");

    let url = (req.body?.url || "").trim().replace(/\/+$/, "");
    const apiKey = (req.body?.apiKey || "").trim();
    const validation = validateLidarrTestCredentials(url, apiKey);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    url = validation.url;

    const results = await withTemporaryLidarrClient(url, apiKey, (client) =>
      applyLidarrCommunityGuide(client),
    );

    res.json({
      success: true,
      message: "Community guide settings applied successfully",
      results,
    });
  } catch (error) {
    console.error("Onboarding community guide error:", error);
    res.status(500).json({
      error: "Failed to apply community guide settings",
      message: error.message,
      details: error.response?.data,
    });
  }
});

router.post("/slskd/test", async (req, res) => {
  try {
    const { testSlskdWithCredentials } =
      await import("../services/slskdClient.js");
    const url = (req.body?.url || "").trim();
    const apiKey = (req.body?.apiKey || "").trim();
    const result = await testSlskdWithCredentials(url, apiKey);
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

router.post("/complete", async (req, res) => {
  try {
    const {
      authUser,
      authPassword,
      lidarr,
      metadata,
      navidrome,
      lastfm,
      slskd,
      ticketmaster,
      downloadFolderPath,
    } = req.body;
    if (authPassword != null && String(authPassword).length > 0) {
      const passwordValidation = requirePasswordStrength(authPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
    }

    const current = dbOps.getSettings();
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
      lidarr:
        lidarr && (lidarr.url || lidarr.apiKey)
          ? {
              ...(current.integrations?.lidarr || {}),
              ...lidarr,
              qualityProfileId:
                lidarr.qualityProfileId != null
                  ? parseInt(lidarr.qualityProfileId, 10) || null
                  : current.integrations?.lidarr?.qualityProfileId ?? null,
              metadataProfileId:
                lidarr.metadataProfileId != null
                  ? parseInt(lidarr.metadataProfileId, 10) || null
                  : current.integrations?.lidarr?.metadataProfileId ?? null,
              defaultMonitorOption:
                lidarr.defaultMonitorOption != null
                  ? String(lidarr.defaultMonitorOption)
                  : current.integrations?.lidarr?.defaultMonitorOption || "none",
              searchOnAdd: lidarr.searchOnAdd === true,
            }
          : current.integrations?.lidarr,
      metadata:
        metadata && (metadata.baseUrl || metadata.userAgentSuffix)
          ? {
              ...(current.integrations?.metadata || {}),
              provider: "brainzmash",
              baseUrl: normalizeMetadataBaseUrl(
                metadata.baseUrl != null
                  ? String(metadata.baseUrl).trim().replace(/\/+$/, "")
                  : current.integrations?.metadata?.baseUrl ||
                    DEFAULT_METADATA_BASE_URL,
              ),
              userAgentSuffix:
                metadata.userAgentSuffix != null
                  ? String(metadata.userAgentSuffix).trim()
                  : current.integrations?.metadata?.userAgentSuffix || "",
              enableNarrowFallbacks:
                metadata.enableNarrowFallbacks !== false,
            }
          : current.integrations?.metadata,
      navidrome:
        navidrome && (navidrome.url || navidrome.username)
          ? { ...(current.integrations?.navidrome || {}), ...navidrome }
          : current.integrations?.navidrome,
      lastfm:
        lastfm && (lastfm.apiKey || lastfm.username)
          ? {
              ...(current.integrations?.lastfm || {}),
              apiKey:
                lastfm.apiKey != null
                  ? String(lastfm.apiKey).trim()
                  : current.integrations?.lastfm?.apiKey ?? "",
              username:
                lastfm.username != null
                  ? String(lastfm.username).trim()
                  : current.integrations?.lastfm?.username ?? "",
            }
          : current.integrations?.lastfm,
      slskd:
        slskd && (slskd.url || slskd.apiKey)
          ? { ...(current.integrations?.slskd || {}), ...slskd }
          : current.integrations?.slskd,
      ticketmaster:
        ticketmaster && ticketmaster.apiKey
          ? {
              ...(current.integrations?.ticketmaster || {}),
              apiKey:
                ticketmaster.apiKey != null
                  ? String(ticketmaster.apiKey).trim()
                  : current.integrations?.ticketmaster?.apiKey ?? "",
              searchRadiusMiles:
                ticketmaster.searchRadiusMiles != null
                  ? Math.max(
                      5,
                      Math.min(
                        250,
                        Math.floor(Number(ticketmaster.searchRadiusMiles)),
                      ),
                    )
                  : current.integrations?.ticketmaster?.searchRadiusMiles ?? 250,
            }
          : current.integrations?.ticketmaster,
    };

    const nextSettings = {
      ...current,
      integrations,
      onboardingComplete: true,
    };
    if (downloadFolderPath !== undefined) {
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
    } else if (!current.downloadFolderPath) {
      const validation = validateDownloadFolderPath(
        getSuggestedDownloadFolderPath(),
        undefined,
        { create: true },
      );
      if (!validation.valid) {
        return res.status(400).json({
          error: "download_folder_required",
          message:
            "Choose a downloads folder before completing onboarding.",
        });
      }
      nextSettings.downloadFolderPath = validation.path;
    }
    dbOps.updateSettings(nextSettings);
    const { refreshPlaylistRuntimeRoots } = await import(
      "../services/playlistRuntime.js"
    );
    await refreshPlaylistRuntimeRoots();

    const authUserFinal = integrations?.general?.authUser || "admin";
    const authPasswordFinal = integrations?.general?.authPassword || "";
    if (authPasswordFinal && userOps.getAllUsers().length === 0) {
      const hash = bcrypt.hashSync(authPasswordFinal, 10);
      const created = userOps.createUser(authUserFinal, hash, "admin", null);
      const initialListenHistory = getDefaultListenHistoryProfile(nextSettings);
      if (created && initialListenHistory) {
        userOps.updateUser(created.id, initialListenHistory);
      }
    }

    const hasLastfm =
      integrations?.lastfm?.apiKey && integrations?.lastfm?.username;
    const hasLidarr = !!integrations?.lidarr?.apiKey;
    if (hasLastfm || hasLidarr) {
      const { requestDiscoveryRefresh } = await import(
        "../services/discoveryRefreshScheduler.js"
      );
      requestDiscoveryRefresh({ reason: "onboarding" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Onboarding complete error:", error);
    res.status(500).json({
      error: "Failed to save onboarding",
      message: error.message,
    });
  }
});

export default router;
