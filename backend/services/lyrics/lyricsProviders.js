import { dbOps } from "../../db/helpers/index.js";
import { assertLyricsProvider } from "./lyricsProvider.js";
import { LrclibClient, lrclibClient, lrclibSettings } from "../lrclibClient.js";

// Adding a provider means adding it to all three: its settings definition for
// the Lyrics settings page, a factory so its config can be tested before it is
// saved, and the instance the lookup order is built from.
const definitions = Object.freeze({
  lrclib: lrclibSettings,
});

const factories = {
  lrclib: () => new LrclibClient(),
};

const providers = [lrclibClient].map(assertLyricsProvider);

export function getLyricsProviderSettings() {
  return structuredClone(definitions);
}

export function getLyricsProviders() {
  const integrations = dbOps.getSettings()?.integrations || {};
  for (const provider of providers) {
    provider.updateConfig(integrations[provider.key] || {});
  }
  return providers
    .filter((provider) => provider.isConfigured())
    .sort((a, b) => a.getPriority() - b.getPriority());
}

export function getLyricsProvider(key) {
  const wanted = String(key || "");
  return getLyricsProviders().find((provider) => provider.key === wanted) || null;
}

export async function testLyricsProvider(key, config = {}) {
  const provider = factories[key]?.();
  if (!provider) throw new Error(`Unknown lyrics provider: ${key}`);
  provider.updateConfig(config);
  return provider.testConnection();
}

// Providers are tried in priority order; the first one holding lyrics wins.
export async function findLyrics(track = {}) {
  const errors = [];
  for (const provider of getLyricsProviders()) {
    try {
      const lyrics = await provider.getLyrics(track);
      if (lyrics) return { provider: provider.key, ...lyrics };
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return null;
}
