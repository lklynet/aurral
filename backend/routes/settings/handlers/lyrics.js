import { validateExternalUrl } from "../../../middleware/urlValidator.js";
import {
  getLyricsProviderSettings,
  testLyricsProvider,
} from "../../../services/lyrics/lyricsProviders.js";

function validateLyricsTestConfig(config) {
  const nextConfig =
    config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const url = String(nextConfig.url || "").trim();
  if (!url) return nextConfig;
  const validation = validateExternalUrl(url);
  if (!validation.valid) {
    throw new Error(`Server URL: ${validation.error}`);
  }
  nextConfig.url = validation.url;
  return nextConfig;
}

export function registerLyrics(router) {
  router.get("/lyrics", (_req, res) => {
    res.json({ providers: getLyricsProviderSettings() });
  });

  router.post("/lyrics/:key/test", async (req, res) => {
    try {
      const config = validateLyricsTestConfig(req.body);
      const result = await testLyricsProvider(req.params.key, config);
      if (!result.configured) {
        return res.status(400).json(result);
      }
      if (!result.ok) {
        return res.status(502).json(result);
      }
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(400).json({
        error: "Connection failed",
        message: error.message,
      });
    }
  });
}
