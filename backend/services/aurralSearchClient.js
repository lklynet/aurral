import { dbOps } from "../config/db-helpers.js";
import { DEFAULT_SEARCH_URL } from "../config/constants.js";

function getSettingsSearch() {
  return dbOps.getSettings().integrations?.search || {};
}

export function getSearchBaseUrl() {
  const search = getSettingsSearch();
  if (search.url === "") {
    return "";
  }
  return String(
    process.env.AURRAL_SEARCH_URL || search.url || DEFAULT_SEARCH_URL,
  )
    .trim()
    .replace(/\/+$/, "");
}

function getSearchApiKey() {
  return String(
    process.env.AURRAL_SEARCH_API_KEY || getSettingsSearch().apiKey || "",
  ).trim();
}

export function isRemoteSearchConfigured() {
  return Boolean(getSearchBaseUrl());
}

const DEFAULT_TIMEOUT_MS = 10000;
const FULL_TIMEOUT_MS = 15000;

function getRemoteTimeoutMs(mode) {
  return String(mode || "").trim() === "full"
    ? FULL_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
}

export async function searchRemoteCatalog(query, { mode = "suggest", limit } = {}) {
  const baseUrl = getSearchBaseUrl();
  if (!baseUrl) return null;

  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", String(query || "").trim());
  url.searchParams.set("mode", mode);
  if (limit != null) {
    url.searchParams.set("limit", String(limit));
  }

  const headers = { Accept: "application/json" };
  const apiKey = getSearchApiKey();
  if (apiKey) {
    headers["X-Aurral-Search-Key"] = apiKey;
  }

  const controller = new AbortController();
  const timeoutMs = getRemoteTimeoutMs(mode);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`aurral-search ${response.status}`);
    }
    const payload = await response.json();
    const catalog = payload?.catalog || payload;
    return {
      top: payload?.top ?? catalog?.top ?? null,
      artists: Array.isArray(catalog?.artists) ? catalog.artists : [],
      albums: Array.isArray(catalog?.albums) ? catalog.albums : [],
      tracks: Array.isArray(catalog?.tracks) ? catalog.tracks : [],
    };
  } catch (error) {
    console.warn(
      `[AurralSearch] Remote catalog search failed (${baseUrl}):`,
      error.message,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRemoteSearchHealth() {
  const baseUrl = getSearchBaseUrl();
  if (!baseUrl) return { configured: false, ok: false };

  const headers = { Accept: "application/json" };
  const apiKey = getSearchApiKey();
  if (apiKey) {
    headers["X-Aurral-Search-Key"] = apiKey;
  }

  try {
    const response = await fetch(`${baseUrl}/health`, { headers });
    const payload = await response.json();
    return {
      configured: true,
      ok: response.ok && payload?.ok === true,
      url: baseUrl,
      health: payload,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      url: baseUrl,
      error: error.message,
    };
  }
}
