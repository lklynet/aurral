const REQUIRED_METHODS = [
  "isConfigured",
  "testConnection",
  "getStatus",
  "updateConfig",
  "getPriority",
  "getLyrics",
];

export function assertLyricsProvider(provider) {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) {
    throw new TypeError("LyricsProvider must be an object");
  }
  for (const property of ["key", "name"]) {
    if (typeof provider[property] !== "string" || !provider[property].trim()) {
      throw new TypeError(`LyricsProvider.${property} must be a non-empty string`);
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`LyricsProvider.${method} must be a function`);
    }
  }
  return provider;
}
