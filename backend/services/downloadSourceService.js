import { dbOps } from "../db/helpers/index.js";
import { prowlarrClient } from "./prowlarrClient.js";
import { getDownloadClient } from "./download/downloadClientSettings.js";

const SOURCE_LABELS = {
  slskd: "Soulseek",
  usenet: "Usenet",
  ytdlp: "yt-dlp",
};

function normalizePriority(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
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
  const integrations = getIntegrations();
  if (getDownloadClient("sabnzbd")?.isConfigured()) {
    return normalizePriority(integrations.sabnzbd?.priority, 20);
  }
  return normalizePriority(integrations.nzbget?.priority, 20);
}

function getYtdlpPriority() {
  const ytdlp = getIntegrations().ytdlp || {};
  return normalizePriority(ytdlp.priority, 50);
}

export function getDownloadSourceStatus() {
  const slskdClient = getDownloadClient("slskd");
  const nzbgetClient = getDownloadClient("nzbget");
  const sabnzbdClient = getDownloadClient("sabnzbd");
  const ytdlpClient = getDownloadClient("ytdlp");
  const slskdConfigured = isSlskdEnabled() && slskdClient.isConfigured();
  const prowlarrConfigured = prowlarrClient.isConfigured();
  const nzbgetConfigured = nzbgetClient.isConfigured();
  const sabnzbdConfigured = sabnzbdClient.isConfigured();
  const usenetConfigured = prowlarrConfigured && (nzbgetConfigured || sabnzbdConfigured);
  const ytdlpConfigured = ytdlpClient.isConfigured();
  return {
    slskd: {
      id: "slskd",
      label: SOURCE_LABELS.slskd,
      enabled: isSlskdEnabled(),
      configured: slskdConfigured,
      priority: getSlskdPriority(),
    },
    usenet: {
      id: "usenet",
      label: SOURCE_LABELS.usenet,
      enabled: usenetConfigured,
      configured: usenetConfigured,
      priority: getUsenetPriority(),
      prowlarrConfigured,
      nzbgetConfigured,
      sabnzbdConfigured,
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

export function getEnabledDownloadSources() {
  const status = getDownloadSourceStatus();
  const sources = [];
  if (status.slskd.configured) sources.push(status.slskd);
  if (status.usenet.configured) sources.push(status.usenet);
  if (status.ytdlp.configured) sources.push(status.ytdlp);
  return sources.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.id.localeCompare(right.id);
  });
}

export function isAnyDownloadSourceConfigured() {
  return getEnabledDownloadSources().length > 0;
}

export function getDownloadSourceNotConfiguredMessage() {
  const status = getDownloadSourceStatus();
  const pieces = [];
  if (!status.slskd.configured) pieces.push("slskd");
  if (!status.usenet.configured) pieces.push("Prowlarr + NZBGet or SABnzbd");
  if (!status.ytdlp.configured) pieces.push("yt-dlp");
  return `No download source is configured. Configure ${pieces.join(" or ")} in Settings > Integrations to enable downloads for flows and playlists.`;
}

export function getSourceLabel(sourceId) {
  return SOURCE_LABELS[String(sourceId || "")] || String(sourceId || "download source");
}
