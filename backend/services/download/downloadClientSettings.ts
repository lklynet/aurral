import { dbOps } from "../../db/helpers/index.ts";
import { DownloadClientRegistry } from "./downloadClientRegistry.ts";
import { SlskdClient, slskdClient, slskdSettings } from "../slskdClient.ts";
import { NzbgetClient, nzbgetClient, nzbgetSettings } from "../nzbgetClient.ts";
import { SabnzbdClient, sabnzbdClient, sabnzbdSettings } from "../sabnzbdClient.ts";
import { YtdlpClient, ytdlpClient, ytdlpSettings } from "../ytdlpClient.ts";
import { DeemixClient, deemixClient, deemixSettings } from "../deemixClient.ts";

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

export function getDownloadClient(key: string | null) {
  downloadClientRegistry.updateConfig(dbOps.getSettings()?.integrations || {});
  return downloadClientRegistry.get(key);
}

export async function testDownloadClient(key: string, config: Record<string, unknown> = {}) {
  const client = factories[key]?.();
  if (!client) throw new Error(`Unknown download client: ${key}`);
  client.updateConfig(config);
  return client.testConnection({ force: true });
}
