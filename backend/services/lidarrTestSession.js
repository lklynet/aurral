import { validateExternalUrl } from "../middleware/urlValidator.js";

export function resolveLidarrTestCredentials(query = {}, configuredClient = null) {
  const testUrl = String(query.url || "").trim();
  const testApiKey = String(query.apiKey || "").trim();
  if (testUrl && testApiKey) {
    return { url: testUrl, apiKey: testApiKey, usingProvided: true };
  }
  configuredClient?.updateConfig?.();
  const config = configuredClient?.getConfig?.() || {};
  return {
    url: String(config.url || "").trim(),
    apiKey: String(config.apiKey || "").trim(),
    usingProvided: false,
  };
}

export function validateLidarrTestCredentials(url, apiKey) {
  if (!url || !apiKey) {
    return { valid: false, error: "Lidarr URL and API key are required" };
  }
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    return { valid: false, error: urlValidation.error };
  }
  return { valid: true, url: urlValidation.url.replace(/\/+$/, "") };
}

export async function withTemporaryLidarrClient(url, apiKey, fn) {
  const { lidarrClient } = await import("./lidarrClient.js");
  const originalConfig = { ...lidarrClient.config };
  const originalApiPath = lidarrClient.apiPath;
  const originalHoldConfig = lidarrClient._holdConfig;

  lidarrClient._holdConfig = true;
  lidarrClient.config = {
    url: url.replace(/\/+$/, ""),
    apiKey: apiKey.trim(),
    insecure: originalConfig.insecure,
    timeoutMs: originalConfig.timeoutMs,
    circuitDisabled: true,
  };
  lidarrClient.apiPath = "/api/v1";

  try {
    return await fn(lidarrClient);
  } finally {
    lidarrClient._holdConfig = originalHoldConfig;
    lidarrClient.config = originalConfig;
    lidarrClient.apiPath = originalApiPath;
    lidarrClient.updateConfig();
  }
}
