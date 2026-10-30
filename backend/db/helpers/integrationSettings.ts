import * as v from "valibot";
import { logger } from "../../services/logger.ts";
import { lenient, listOf, recordOf } from "./storedSchemas.ts";

const number = v.pipe(
  v.union([v.number(), v.pipe(v.string(), v.trim(), v.nonEmpty(), v.transform(Number))]),
  v.finite(),
);

const text = lenient(v.string());
const nullableText = lenient(v.nullable(v.string()));
const flag = lenient(v.boolean());
const count = lenient(number);
const id = lenient(v.nullable(number));

const service = <Entries extends v.ObjectEntries>(entries: Entries) =>
  lenient(v.looseObject(entries));

const webhookSettings = {
  webhooks: lenient(
    listOf(
      v.looseObject({
        url: v.string(),
        headers: lenient(listOf(v.looseObject({ key: v.string(), value: v.string() }))),
        body: nullableText,
      }),
    ),
  ),
  webhookEvents: service({
    notifyDiscoveryUpdated: flag,
    notifyWeeklyFlowDone: flag,
    notifyRequestMade: flag,
    notifyRequestAvailable: flag,
  }),
};

export const webhookSettingsSchema = v.looseObject(webhookSettings);

export const integrationSettingsSchema = v.looseObject({
  ...webhookSettings,
  navidrome: service({ url: text, username: text, password: text, prefixOwnerUsername: flag }),
  plex: service({
    url: text,
    token: text,
    clientId: text,
    machineIdentifier: text,
    downloadsPath: text,
    plexUsername: nullableText,
    mainLibrarySectionId: text,
    loginEnabled: flag,
    configuredByUserId: count,
  }),
  jellyfin: service({ url: text, apiKey: text, userId: text }),
  lastfm: service({
    apiKey: text,
    apiSecret: text,
    discoveryPeriod: text,
    discoveryAutoRefreshHours: count,
    discoveryRecommendationsPerRefresh: count,
    discoveryMode: text,
  }),
  slskd: service({
    enabled: flag,
    url: text,
    apiKey: text,
    priority: count,
    preferredFormat: text,
    preferredFormatStrict: flag,
    cleanupAfterRuns: flag,
  }),
  prowlarr: service({
    enabled: flag,
    url: text,
    apiKey: text,
    indexers: lenient(recordOf(v.looseObject({ enabled: flag, priority: count }))),
    categories: lenient(listOf(number)),
    maxResults: count,
  }),
  nzbget: service({
    enabled: flag,
    url: text,
    username: text,
    password: text,
    category: text,
    priority: count,
    nzbPriority: count,
    addPaused: flag,
    completedPath: text,
    deleteLeftovers: flag,
  }),
  sabnzbd: service({
    enabled: flag,
    url: text,
    apiKey: text,
    category: text,
    deleteLeftovers: flag,
    priority: count,
    addPaused: flag,
  }),
  ytdlp: service({ enabled: flag, priority: count, stagingPath: text }),
  deemix: service({ enabled: flag, url: text, bitrate: count, priority: count }),
  ticketmaster: service({
    apiKey: text,
    searchRadiusMiles: count,
    localDiscoveryIncludeRecommendations: flag,
    localDiscoveryIncludeTrending: flag,
  }),
  news: service({
    enabled: flag,
    feeds: lenient(
      listOf(v.looseObject({ id: text, name: text, url: v.string(), group: text, enabled: flag })),
    ),
    groups: lenient(recordOf(v.boolean())),
  }),
  lidarr: service({
    url: text,
    externalUrl: text,
    apiKey: text,
    rootFolderPath: nullableText,
    rootFolderPaths: lenient(listOf(v.string())),
    qualityProfileId: id,
    metadataProfileId: id,
    tagId: id,
    defaultMonitorOption: text,
    searchOnAdd: flag,
    enabled: flag,
    insecure: flag,
  }),
  metadata: service({
    provider: text,
    baseUrl: text,
    userAgentSuffix: text,
    enableNarrowFallbacks: flag,
  }),
  general: service({ authUser: text, authPassword: text, apiKey: text }),
  gotify: service({
    url: text,
    token: text,
    notifyDiscoveryUpdated: flag,
    notifyWeeklyFlowDone: flag,
    notifyRequestMade: flag,
    notifyRequestAvailable: flag,
  }),
  google: service({ enabled: flag, clientId: text, clientSecret: text, redirectUri: text }),
  musicbrainz: service({ email: text, customUrl: text }),
});

export type StoredIntegrations = v.InferOutput<typeof integrationSettingsSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function droppedPaths(stored: unknown, read: unknown, path: string): string[] {
  if (stored == null || stored === "") return [];
  if (read === undefined) return [path];
  if (Array.isArray(stored)) {
    if (!Array.isArray(read) || read.length !== stored.length) return [path];
    return stored.flatMap((item, index) => droppedPaths(item, read[index], `${path}.${index}`));
  }
  if (!isRecord(stored) || !isRecord(read)) return [];
  return Object.entries(stored).flatMap(([key, value]) =>
    droppedPaths(value, read[key], path ? `${path}.${key}` : key),
  );
}

let lastWarned = "";

export function readIntegrationSettings(stored: unknown) {
  const integrations = v.parse(integrationSettingsSchema, isRecord(stored) ? stored : {});
  return { integrations, unreadable: droppedPaths(stored, integrations, "") };
}

export function warnUnreadableIntegrationSettings(unreadable: string[]) {
  const key = unreadable.join(", ");
  if (key && key !== lastWarned) {
    logger.warn("settings", "Ignored integration settings Aurral can't read", { settings: key });
  }
  lastWarned = key;
}
