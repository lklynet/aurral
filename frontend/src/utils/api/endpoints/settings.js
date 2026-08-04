import { getData, postData, lidarrCredentialParams } from "../core.js";

export const startPlexAuth = (forwardUrl) =>
  postData("/settings/plex/auth/pin", { forwardUrl });

export const checkPlexAuth = (pinId, code) =>
  postData("/settings/plex/auth/check", { pinId, code });

export const getPlexResources = (token) =>
  postData("/settings/plex/resources", { token });

export const testPlexConnection = (url, token) =>
  postData("/settings/plex/test", {
    url: url?.replace(/\/+$/, ""),
    token,
  });

export const testNavidromeConnection = (url, username, password) =>
  postData("/settings/navidrome/test", {
    url: url?.replace(/\/+$/, ""),
    username,
    password,
  });

export const syncPlexNow = () => postData("/settings/plex/sync");

export const getPlexLibraries = () => getData("/settings/plex/libraries");

export const checkPlexLibraryAccess = (sectionId) =>
  getData(`/settings/plex/libraries/${encodeURIComponent(sectionId)}/access-check`);

export const getAppSettings = () => getData("/settings");

export const updateAppSettings = (settings) => postData("/settings", settings);

export const getLidarrRootFolders = (url, apiKey) =>
  getData("/settings/lidarr/root-folders", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getLidarrProfiles = (url, apiKey) =>
  getData("/settings/lidarr/profiles", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getLidarrMetadataProfiles = (url, apiKey) =>
  getData("/settings/lidarr/metadata-profiles", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getLidarrTags = (url, apiKey) =>
  getData("/settings/lidarr/tags", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const testSlskdConnection = () => postData("/settings/slskd/test");

export const testProwlarrConnection = () => postData("/settings/prowlarr/test");

export const getProwlarrIndexers = () => getData("/settings/prowlarr/indexers");

export const testNzbgetConnection = () => postData("/settings/nzbget/test");

export const testSabnzbdConnection = () => postData("/settings/sabnzbd/test");

export const testYtdlpConnection = () => postData("/settings/ytdlp/test");

export const testLidarrConnection = (url, apiKey) =>
  getData("/settings/lidarr/test", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const testLidarrLibraryAccess = (url, apiKey) =>
  getData("/settings/lidarr/test-library-access", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getStorageHealth = ({ force = false } = {}) =>
  getData("/settings/storage-health", {
    params: force ? { force: "1" } : undefined,
  });

export const getSettingsTasks = () => getData("/settings/tasks");

export const clearSettingsStaleTasks = () =>
  postData("/settings/tasks/clear-stale");

export const testGotifyConnection = (url, token) =>
  postData("/settings/gotify/test", { url, token });

export const applyLidarrCommunityGuide = () =>
  postData("/settings/lidarr/apply-community-guide");
