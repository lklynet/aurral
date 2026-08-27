import { validateExternalUrl } from "../../../middleware/urlValidator.js";
import {
  getDownloadClient,
  getDownloadClientSettings,
  testDownloadClient,
} from "../../../services/download/downloadClientSettings.js";

function validateDownloadClientTestConfig(key, config) {
  const definition = getDownloadClientSettings()[key];
  const nextConfig =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...config }
      : {};

  for (const field of definition?.fields || []) {
    if (field.type !== "url") continue;
    const value = nextConfig[field.key];
    if (value == null || String(value).trim() === "") continue;
    const validation = validateExternalUrl(value);
    if (!validation.valid) {
      throw new Error(`${field.label || field.key}: ${validation.error}`);
    }
    nextConfig[field.key] = validation.url;
  }

  return nextConfig;
}

function registerClientTest(router, path, importClient, label, { warning } = {}) {
  router.post(path, async (_req, res) => {
    try {
      const client = await importClient();
      const result = await client.testConnection({ force: true });
      if (!result.configured) {
        return res.status(400).json(result);
      }
      if (!result.ok) {
        return res.status(502).json(result);
      }
      return res.json(
        warning
          ? { success: true, warning: result.warning === true, ...result }
          : { success: true, ...result },
      );
    } catch (error) {
      return res.status(500).json({
        error: `${label} test failed`,
        message: error.message,
      });
    }
  });
}

export function registerDownloadClients(router) {
  router.get("/download-clients", (_req, res) => {
    res.json({ clients: getDownloadClientSettings() });
  });

  router.post("/download-clients/:key/test", async (req, res) => {
    try {
      const config = validateDownloadClientTestConfig(req.params.key, req.body);
      const result = await testDownloadClient(req.params.key, config);
      if (!result.configured) {
        return res.status(400).json(result);
      }
      if (!result.ok) {
        return res.status(502).json(result);
      }
      return res.json({ success: true, warning: result.warning === true, ...result });
    } catch (error) {
      return res.status(400).json({
        error: "Connection failed",
        message: error.message,
      });
    }
  });

  registerClientTest(
    router,
    "/slskd/test",
    async () => getDownloadClient("slskd"),
    "slskd",
    { warning: true },
  );

  registerClientTest(
    router,
    "/prowlarr/test",
    async () => (await import("../../../services/prowlarrClient.js")).prowlarrClient,
    "Prowlarr",
  );

  router.get("/prowlarr/indexers", async (_req, res) => {
    try {
      const { prowlarrClient } = await import("../../../services/prowlarrClient.js");
      const indexers = await prowlarrClient.listUsenetIndexers();
      return res.json({ indexers });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to load Prowlarr indexers",
        message: error.message,
      });
    }
  });

  registerClientTest(
    router,
    "/nzbget/test",
    async () => getDownloadClient("nzbget"),
    "NZBGet",
  );

  registerClientTest(
    router,
    "/sabnzbd/test",
    async () => getDownloadClient("sabnzbd"),
    "SABnzbd",
  );

  registerClientTest(
    router,
    "/ytdlp/test",
    async () => getDownloadClient("ytdlp"),
    "yt-dlp",
  );

  router.post("/gotify/test", async (req, res) => {
    try {
      const { sendGotifyTest } =
        await import("../../../services/notificationService.js");
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
}
