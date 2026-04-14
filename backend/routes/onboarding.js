import express from "express";
import bcrypt from "bcrypt";
import { dbOps, userOps } from "../config/db-helpers.js";
import { defaultData } from "../config/constants.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { requirePasswordStrength } from "../middleware/validation.js";
import { getRawLidarrApiKey } from "../services/apiClients.js";

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

router.get("/lidarr/test", async (req, res) => {
  try {
    const { lidarrClient } = await import("../services/lidarrClient.js");
    let url = (req.query.url || "").trim().replace(/\/+$/, "");
    const apiKey = getRawLidarrApiKey();

    if (!apiKey) {
      return res.status(400).json({ error: "Lidarr API key is not configured" });
    }
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

router.post("/complete", async (req, res) => {
  try {
    const { authUser, authPassword, lidarr, musicbrainz, navidrome, lastfm } =
      req.body;
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
          ? { ...(current.integrations?.lidarr || {}), ...lidarr }
          : current.integrations?.lidarr,
      musicbrainz:
        musicbrainz && musicbrainz.email != null
          ? {
              ...(current.integrations?.musicbrainz || {}),
              email: String(musicbrainz.email).trim(),
            }
          : current.integrations?.musicbrainz,
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
    };

    dbOps.updateSettings({
      ...current,
      integrations,
      onboardingComplete: true,
    });

    const authUserFinal = integrations?.general?.authUser || "admin";
    const authPasswordFinal = integrations?.general?.authPassword || "";
    if (authPasswordFinal && userOps.getAllUsers().length === 0) {
      const hash = bcrypt.hashSync(authPasswordFinal, 10);
      userOps.createUser(authUserFinal, hash, "admin", null);
    }

    const hasLastfm =
      integrations?.lastfm?.apiKey && integrations?.lastfm?.username;
    const hasLidarr = !!integrations?.lidarr?.apiKey;
    if (hasLastfm || hasLidarr) {
      const { updateDiscoveryCache } = await import(
        "../services/discoveryService.js"
      );
      updateDiscoveryCache().catch((err) => {
        console.error("[Onboarding] Discovery refresh failed:", err.message);
      });
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
