import { isOwnKey } from "../../lib/ownKey.ts";
import { dbOps } from "../db/helpers/index.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { getDownloadClient, getUsenetClient } from "./download/downloadClientSettings.ts";
import { activePluginSources, pluginSourceLabel } from "./plugins/pluginStore.ts";

const SOURCE_LABELS = {
  slskd: "Soulseek",
  usenet: "Usenet",
  tidarr: "Tidarr",
  deemix: "deemix",
  ytdlp: "yt-dlp",
  share: "Aurral share",
};

function normalizePriority(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function normalizeAlbumPriority(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function getIntegrations() {
  return dbOps.getSettings()?.integrations || {};
}

function isSlskdEnabled() {
  const slskd = getIntegrations().slskd || {};
  return slskd.enabled === true;
}

function getSlskdPriority() {
  const slskd = getIntegrations().slskd || {};
  return normalizePriority(slskd.priority, 10);
}

function getUsenetPriority() {
  const { key } = getUsenetClient();
  return normalizePriority(dbOps.getSettings()?.integrations?.[key]?.priority, 20);
}

function getTidarrPriority() {
  return normalizePriority(getIntegrations().tidarr?.priority, 20);
}

function getUsenetAlbumPriority() {
  const { key } = getUsenetClient();
  return normalizeAlbumPriority(dbOps.getSettings()?.integrations?.[key]?.albumPriority);
}

function getDeemixPriority() {
  const deemix = getIntegrations().deemix || {};
  return normalizePriority(deemix.priority, 15);
}

function getYtdlpPriority() {
  const ytdlp = getIntegrations().ytdlp || {};
  return normalizePriority(ytdlp.priority, 50);
}

export function getDownloadSourceStatus() {
  const slskdClient = getDownloadClient("slskd");
  const nzbgetClient = getDownloadClient("nzbget");
  const sabnzbdClient = getDownloadClient("sabnzbd");
  const tidarrClient = getDownloadClient("tidarr");
  const ytdlpClient = getDownloadClient("ytdlp");
  const deemixClient = getDownloadClient("deemix");
  const slskdConfigured = isSlskdEnabled() && slskdClient.isConfigured();
  const prowlarrConfigured = prowlarrClient.isConfigured();
  const nzbgetConfigured = nzbgetClient.isConfigured();
  const sabnzbdConfigured = sabnzbdClient.isConfigured();
  const tidarrConfigured = tidarrClient.isConfigured();
  const usenetConfigured = prowlarrConfigured && (nzbgetConfigured || sabnzbdConfigured);
  const ytdlpConfigured = ytdlpClient.isConfigured();
  const deemixConfigured = deemixClient.isConfigured();
  return {
    slskd: {
      id: "slskd",
      label: SOURCE_LABELS.slskd,
      enabled: isSlskdEnabled(),
      configured: slskdConfigured,
      priority: getSlskdPriority(),
      albumPriority: normalizeAlbumPriority(getIntegrations().slskd?.albumPriority),
    },
    usenet: {
      id: "usenet",
      label: SOURCE_LABELS.usenet,
      enabled: usenetConfigured,
      configured: usenetConfigured,
      priority: getUsenetPriority(),
      albumPriority: getUsenetAlbumPriority(),
      prowlarrConfigured,
      nzbgetConfigured,
      sabnzbdConfigured,
    },
    tidarr: {
      id: "tidarr",
      label: SOURCE_LABELS.tidarr,
      enabled: getIntegrations().tidarr?.enabled === true,
      configured: tidarrConfigured,
      priority: getTidarrPriority(),
      albumPriority: normalizeAlbumPriority(getIntegrations().tidarr?.albumPriority),
    },
    deemix: {
      id: "deemix",
      label: SOURCE_LABELS.deemix,
      enabled: deemixClient.isEnabled(),
      configured: deemixConfigured,
      priority: getDeemixPriority(),
      albumPriority: normalizeAlbumPriority(getIntegrations().deemix?.albumPriority),
    },
    ytdlp: {
      id: "ytdlp",
      label: SOURCE_LABELS.ytdlp,
      enabled: ytdlpClient.isEnabled(),
      configured: ytdlpConfigured,
      priority: getYtdlpPriority(),
    },
  };
}

export type SourceOrder = "track" | "album";

const sourceRank = (
  source: { priority: number; albumPriority?: number | null },
  order: SourceOrder,
) => (order === "album" ? (source.albumPriority ?? source.priority) : source.priority);

export function getEnabledDownloadSources(order: SourceOrder = "track") {
  const status = getDownloadSourceStatus();
  const sources = [];
  if (status.slskd.configured) sources.push(status.slskd);
  if (status.usenet.configured) sources.push(status.usenet);
  if (status.tidarr.configured) sources.push(status.tidarr);
  if (status.deemix.configured) sources.push(status.deemix);
  if (status.ytdlp.configured) sources.push(status.ytdlp);
  sources.push(...activePluginSources());
  return sources.sort(
    (left, right) =>
      sourceRank(left, order) - sourceRank(right, order) || left.id.localeCompare(right.id),
  );
}

const ALBUM_GRAB_SOURCE_IDS = ["slskd", "usenet", "tidarr", "deemix"];

export const isAlbumGrabSource = (source: { id: string; albums?: boolean }) =>
  ALBUM_GRAB_SOURCE_IDS.includes(source.id) || source.albums === true;

export const isAlbumGrabSourceId = (id: string) =>
  ALBUM_GRAB_SOURCE_IDS.includes(id) ||
  activePluginSources().some((source) => source.id === id && source.albums);

// The enabled sources that download only a track and rank above every
// enabled album source, in priority order. A track request searches these
// before its release.
export function getQuickSearchSources() {
  const sources = getEnabledDownloadSources();
  const firstAlbumSource = sources.findIndex(isAlbumGrabSource);
  return firstAlbumSource > 0 ? sources.slice(0, firstAlbumSource).map((source) => source.id) : [];
}

export function isAlbumGrabSourceConfigured() {
  return getEnabledDownloadSources().some(isAlbumGrabSource);
}

export function isAnyDownloadSourceConfigured() {
  return getEnabledDownloadSources().length > 0;
}

export function getDownloadSourceNotConfiguredMessage() {
  const status = getDownloadSourceStatus();
  const pieces = [];
  if (!status.slskd.configured) pieces.push("slskd");
  if (!status.usenet.configured) pieces.push("Prowlarr + SABnzbd/NZBGet");
  if (!status.tidarr.configured) pieces.push("Tidarr");
  if (!status.deemix.configured) pieces.push("deemix");
  if (!status.ytdlp.configured) pieces.push("yt-dlp");
  return `No download source is configured. Configure ${pieces.join(" or ")} in Settings → Downloads, or turn on a download source plugin, to enable downloads for flows and playlists.`;
}

export function getSourceLabel(sourceId: string | null | undefined) {
  const id = String(sourceId || "");
  return (
    (isOwnKey(SOURCE_LABELS, id) && SOURCE_LABELS[id]) ||
    pluginSourceLabel(id) ||
    id ||
    "download source"
  );
}
