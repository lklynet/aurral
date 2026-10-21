import { validateLidarrTestCredentials, withTemporaryLidarrClient } from "./lidarrTestSession.js";
import { runLidarrLibraryAccessTest } from "./lidarrLibraryAccessTest.js";
import { applyLidarrCommunityGuide } from "./lidarrCommunityGuide.js";
import { logger } from "./logger.js";

function resolve({ url, apiKey }) {
  const validation = validateLidarrTestCredentials(url, apiKey);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), { statusCode: 400 });
  }
  return { url: validation.url, apiKey };
}

export async function fetchQualityProfiles(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getQualityProfiles(true));
}

export async function fetchMetadataProfiles(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getMetadataProfiles(true));
}

export async function fetchRootFolders(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getRootFolders());
}

export async function fetchTags(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getTags(true));
}

export async function testLidarrConnection(credentials) {
  const { url, apiKey } = resolve(credentials);
  const result = await withTemporaryLidarrClient(url, apiKey, (client) =>
    client.testConnection(true),
  );
  logger.info("lidarr", "Test connection result:", result);
  return result;
}

export async function testLidarrLibraryAccess(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => runLidarrLibraryAccessTest(client));
}

export async function applyCommunityGuide(credentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => applyLidarrCommunityGuide(client));
}
