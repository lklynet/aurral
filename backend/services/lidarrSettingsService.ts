import { validateLidarrTestCredentials, withTemporaryLidarrClient } from "./lidarrTestSession.ts";
import { runLidarrLibraryAccessTest } from "./lidarrLibraryAccessTest.ts";
import { applyLidarrCommunityGuide } from "./lidarrCommunityGuide.ts";
import { logger } from "./logger.ts";

type LidarrCredentials = { url: string; apiKey: string };

function resolve({ url, apiKey }: LidarrCredentials) {
  const validation = validateLidarrTestCredentials(url, apiKey);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), { statusCode: 400 });
  }
  return { url: validation.url, apiKey };
}

export async function fetchQualityProfiles(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getQualityProfiles(true));
}

export async function fetchMetadataProfiles(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getMetadataProfiles(true));
}

export async function fetchRootFolders(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getRootFolders());
}

export async function fetchTags(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => client.getTags(true));
}

export async function testLidarrConnection(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  const result = await withTemporaryLidarrClient(url, apiKey, (client) =>
    client.testConnection(true),
  );
  logger.info("lidarr", "Test connection result:", result);
  return result;
}

export async function testLidarrLibraryAccess(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => runLidarrLibraryAccessTest(client));
}

export async function applyCommunityGuide(credentials: LidarrCredentials) {
  const { url, apiKey } = resolve(credentials);
  return withTemporaryLidarrClient(url, apiKey, (client) => applyLidarrCommunityGuide(client));
}
