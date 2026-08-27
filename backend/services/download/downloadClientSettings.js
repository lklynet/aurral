import { dbOps } from "../../db/helpers/index.js";
import { DownloadClientRegistry } from "./downloadClientRegistry.js";
import { SlskdClient, slskdClient, slskdSettings } from "../slskdClient.js";
import { NzbgetClient, nzbgetClient, nzbgetSettings } from "../nzbgetClient.js";
import { SabnzbdClient, sabnzbdClient, sabnzbdSettings } from "../sabnzbdClient.js";
import { YtdlpClient, ytdlpClient, ytdlpSettings } from "../ytdlpClient.js";
import { DeemixClient, deemixClient, deemixSettings } from "../deemixClient.js";

const definitions = Object.freeze({
  slskd: slskdSettings,
  ytdlp: ytdlpSettings,
  nzbget: nzbgetSettings,
  sabnzbd: sabnzbdSettings,
  deemix: deemixSettings,
});

const factories = {
  slskd: () => new SlskdClient(),
  ytdlp: () => new YtdlpClient(),
  nzbget: () => new NzbgetClient(),
  sabnzbd: () => new SabnzbdClient(),
  deemix: () => new DeemixClient(),
};

export const downloadClientRegistry = new DownloadClientRegistry([
  slskdClient,
  ytdlpClient,
  nzbgetClient,
  sabnzbdClient,
  deemixClient,
]);

export function getDownloadClientSettings() {
  return structuredClone(definitions);
}

export function getDownloadClient(key) {
  downloadClientRegistry.updateConfig(dbOps.getSettings()?.integrations || {});
  return downloadClientRegistry.get(key);
}

export async function testDownloadClient(key, config = {}) {
  const client = factories[key]?.();
  if (!client) throw new Error(`Unknown download client: ${key}`);
  client.updateConfig(config);
  return client.testConnection({ force: true });
}
