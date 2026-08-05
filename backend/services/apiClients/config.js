import { dbOps } from "../../db/helpers/index.js";
import { getMetadataBaseUrl, getMetadataProviderHealthSnapshot as getBrainzmashHealthSnapshot } from "../providers/brainzmashProvider.js";

export const getLastfmApiKey = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.lastfm?.apiKey || process.env.LASTFM_API_KEY;
};

export const getTicketmasterApiKey = () => {
  const settings = dbOps.getSettings();
  const configuredValue = settings.integrations?.ticketmaster?.apiKey;
  if (configuredValue !== undefined && configuredValue !== null) {
    return String(configuredValue).trim();
  }
  return String(process.env.TICKETMASTER_API_KEY || "").trim();
};

export const getNewsApiKey = () => {
  const settings = dbOps.getSettings();
  return String(settings.integrations?.newsapi?.apiKey || process.env.NEWSAPI_API_KEY || "").trim();
};

export const getNewsApiSettings = () => {
  const settings = dbOps.getSettings();
  const newsapi = settings.integrations?.newsapi || {};
  return {
    language: String(newsapi.language || "en").trim().toLowerCase() || "en",
    domains: String(newsapi.domains || "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20),
  };
};

export const getMusicBrainzContact = () => {
  const settings = dbOps.getSettings();
  return (
    settings.integrations?.musicbrainz?.email ||
    process.env.CONTACT_EMAIL ||
    "user@example.com"
  );
};

export const getMusicbrainzApiBaseUrl = () => {
  return getMetadataBaseUrl();
};

export const getMetadataProviderHealthSnapshot = () => {
  return getBrainzmashHealthSnapshot();
};
