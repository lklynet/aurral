import { isOwnKey } from "../../../lib/ownKey.ts";
import { USENET_CLIENT_KEYS, isUsenetClientKey } from "../usenetClientCommon.ts";
import { dbOps } from "../../db/helpers/index.ts";
import type { DownloadClient } from "./downloadClient.ts";
import { DownloadClientRegistry } from "./downloadClientRegistry.ts";
import { SlskdClient, slskdClient, slskdSettings } from "../slskdClient.ts";
import { NzbgetClient, nzbgetClient, nzbgetSettings } from "../nzbgetClient.ts";
import {
  SabnzbdClient,
  sabnzbdClient,
  sabnzbdSettings,
  tidarrClient,
  tidarrSettings,
} from "../sabnzbdClient.ts";
import { YtdlpClient, ytdlpClient, ytdlpSettings } from "../ytdlpClient.ts";
import { DeemixClient, deemixClient, deemixSettings } from "../deemixClient.ts";

const definitions = Object.freeze({
  slskd: slskdSettings,
  ytdlp: ytdlpSettings,
  nzbget: nzbgetSettings,
  sabnzbd: sabnzbdSettings,
  tidarr: tidarrSettings,
  deemix: deemixSettings,
});

const factories = {
  slskd: () => new SlskdClient(),
  ytdlp: () => new YtdlpClient(),
  nzbget: () => new NzbgetClient(),
  sabnzbd: () => new SabnzbdClient(),
  tidarr: () => new SabnzbdClient(null, "tidarr"),
  deemix: () => new DeemixClient(),
};

export const downloadClientRegistry = new DownloadClientRegistry([
  slskdClient,
  ytdlpClient,
  nzbgetClient,
  sabnzbdClient,
  tidarrClient,
  deemixClient,
]);

export function getDownloadClientSettings() {
  return structuredClone(definitions);
}

type BuiltInDownloadClients = {
  slskd: SlskdClient;
  ytdlp: YtdlpClient;
  nzbget: NzbgetClient;
  sabnzbd: SabnzbdClient;
  tidarr: SabnzbdClient;
  deemix: DeemixClient;
};

export function getDownloadClient<Key extends keyof BuiltInDownloadClients>(
  key: Key,
): BuiltInDownloadClients[Key];
export function getDownloadClient(
  key: string | null,
): BuiltInDownloadClients[keyof BuiltInDownloadClients] | null;
export function getDownloadClient(key: string | null) {
  downloadClientRegistry.updateConfig(dbOps.getSettings()?.integrations || {});
  return downloadClientRegistry.get(key);
}

export async function testDownloadClient(key: string, config: Record<string, unknown> = {}) {
  if (!isOwnKey(factories, key)) throw new Error(`Unknown download client: ${key}`);
  const client = factories[key]();
  const configurable: DownloadClient = client;
  configurable.updateConfig(config);
  return client.testConnection({ force: true });
}

export function getUsenetClient(key: string | null = null) {
  if (isUsenetClientKey(key)) return getDownloadClient(key);
  const clients = USENET_CLIENT_KEYS.map((entry) => getDownloadClient(entry));
  return clients.find((client) => client.isConfigured()) ?? getDownloadClient("nzbget");
}
