import { validateExternalUrl } from "../middleware/urlValidator.ts";
import type { LidarrClient } from "./lidarrClient.ts";

type LidarrTestConfig = Partial<ReturnType<LidarrClient["getConfig"]>>;

export function resolveLidarrTestCredentials(
  query: { url?: unknown; apiKey?: unknown } = {},
  configuredClient: LidarrClient | null = null,
) {
  const testUrl = String(query.url || "").trim();
  const testApiKey = String(query.apiKey || "").trim();
  if (testUrl && testApiKey) {
    return { url: testUrl, apiKey: testApiKey, usingProvided: true };
  }
  configuredClient?.updateConfig?.();
  if (configuredClient?.isEnabled?.() === false) {
    const error: Error & { statusCode?: number } = new Error("Lidarr is disabled");
    error.statusCode = 400;
    throw error;
  }
  const config: LidarrTestConfig = configuredClient?.getConfig?.() || {};
  return {
    url: String(config.url || "").trim(),
    apiKey: String(config.apiKey || "").trim(),
    usingProvided: false,
  };
}

export function validateLidarrTestCredentials(
  url: string,
  apiKey: string,
): { valid: false; error: string } | { valid: true; url: string } {
  if (!url || !apiKey) {
    return { valid: false, error: "Lidarr URL and API key are required" };
  }
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    return { valid: false, error: urlValidation.error };
  }
  return { valid: true, url: urlValidation.url.replace(/\/+$/, "") };
}

export async function withTemporaryLidarrClient<T>(
  url: string,
  apiKey: string,
  fn: (client: LidarrClient) => T,
): Promise<Awaited<T>> {
  const { LidarrClient } = await import("./lidarrClient.ts");
  // Keep test credentials, cached responses and discovered paths out of the saved client.
  const lidarrClient = new LidarrClient({ persistRootFolderPaths: false });
  const originalConfig = lidarrClient.config;

  lidarrClient._holdConfig = true;
  lidarrClient.config = {
    url: url.replace(/\/+$/, ""),
    apiKey: apiKey.trim(),
    insecure: originalConfig.insecure,
    timeoutMs: originalConfig.timeoutMs,
    circuitDisabled: true,
    rootFolderPath: null,
    rootFolderPaths: [],
  };
  lidarrClient.apiPath = "/api/v1";

  try {
    return await fn(lidarrClient);
  } finally {
    lidarrClient._httpAgent.destroy();
    lidarrClient._httpsAgent.destroy();
    lidarrClient._httpsInsecureAgent.destroy();
  }
}
