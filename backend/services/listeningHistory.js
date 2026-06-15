export const LISTEN_HISTORY_PROVIDERS = ["lastfm", "listenbrainz", "koito"];
export const DEFAULT_LISTEN_HISTORY_PROVIDER = "lastfm";

const CACHE_PREFIX_BY_PROVIDER = {
  lastfm: "lfm",
  listenbrainz: "lb",
  koito: "koito",
};

export function normalizeListenHistoryProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return LISTEN_HISTORY_PROVIDERS.includes(normalized)
    ? normalized
    : DEFAULT_LISTEN_HISTORY_PROVIDER;
}

export function normalizeListenHistoryUsername(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function normalizeListenHistoryUrl(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(/\/+$/, "");
  return normalized || null;
}

export function getListenHistoryProfile(source = {}) {
  const safeSource =
    source && typeof source === "object" && !Array.isArray(source)
      ? source
      : {};
  const explicitUsername =
    safeSource.listenHistoryUsername ?? safeSource.listen_history_username;
  const legacyLastfmUsername =
    safeSource.lastfmUsername ?? safeSource.lastfm_username;
  const username = normalizeListenHistoryUsername(
    explicitUsername != null ? explicitUsername : legacyLastfmUsername,
  );
  const url = normalizeListenHistoryUrl(
    safeSource.listenHistoryUrl ?? safeSource.listen_history_url,
  );
  const hasExplicitProvider =
    safeSource.listenHistoryProvider !== undefined ||
    safeSource.listen_history_provider !== undefined;
  const provider = username || url
    ? hasExplicitProvider
      ? normalizeListenHistoryProvider(
          safeSource.listenHistoryProvider ??
            safeSource.listen_history_provider,
        )
      : legacyLastfmUsername != null
        ? "lastfm"
        : url
          ? "koito"
          : DEFAULT_LISTEN_HISTORY_PROVIDER
    : normalizeListenHistoryProvider(
        safeSource.listenHistoryProvider ??
          safeSource.listen_history_provider,
      );

  return {
    listenHistoryProvider: provider,
    listenHistoryUsername: provider === "koito" ? null : username,
    listenHistoryUrl: provider === "koito" ? url : null,
    lastfmUsername: provider === "lastfm" ? username : null,
  };
}

export function hasListenHistoryProfile(profile) {
  const normalized = getListenHistoryProfile(profile);
  if (normalized.listenHistoryProvider === "koito") {
    return !!normalized.listenHistoryUrl;
  }
  return !!normalizeListenHistoryUsername(normalized.listenHistoryUsername);
}

export function listenHistoryProfilesEqual(a, b) {
  const left = getListenHistoryProfile(a);
  const right = getListenHistoryProfile(b);
  return (
    left.listenHistoryProvider === right.listenHistoryProvider &&
    left.listenHistoryUsername === right.listenHistoryUsername &&
    left.listenHistoryUrl === right.listenHistoryUrl
  );
}

export function getListenHistoryCacheNamespace(profile) {
  const normalized = getListenHistoryProfile(profile);
  if (normalized.listenHistoryProvider === "koito") {
    if (!normalized.listenHistoryUrl) return null;
    return `${CACHE_PREFIX_BY_PROVIDER.koito}:${normalized.listenHistoryUrl}`;
  }
  if (!normalized.listenHistoryUsername) return null;
  const prefix = CACHE_PREFIX_BY_PROVIDER[normalized.listenHistoryProvider];
  return prefix
    ? `${prefix}:${normalized.listenHistoryUsername}`
    : null;
}

export function getDefaultListenHistoryProfile(settings) {
  const username = String(settings?.integrations?.lastfm?.username || "").trim();
  if (!username) return null;
  return {
    listenHistoryProvider: "lastfm",
    listenHistoryUsername: username,
  };
}

export function resolveListenHistorySettings(user = {}, settings = null) {
  const profile = getListenHistoryProfile(user);
  if (hasListenHistoryProfile(profile)) {
    return {
      listenHistoryProvider: profile.listenHistoryProvider,
      listenHistoryUsername: profile.listenHistoryUsername,
      listenHistoryUrl: profile.listenHistoryUrl,
      lastfmUsername: profile.lastfmUsername,
    };
  }
  const defaultProfile = settings ? getDefaultListenHistoryProfile(settings) : null;
  if (defaultProfile) {
    return {
      listenHistoryProvider: defaultProfile.listenHistoryProvider,
      listenHistoryUsername: defaultProfile.listenHistoryUsername,
      listenHistoryUrl: null,
      lastfmUsername: defaultProfile.listenHistoryUsername,
    };
  }
  return {
    listenHistoryProvider: profile.listenHistoryProvider,
    listenHistoryUsername: profile.listenHistoryUsername,
    listenHistoryUrl: profile.listenHistoryUrl,
    lastfmUsername: profile.lastfmUsername,
  };
}
