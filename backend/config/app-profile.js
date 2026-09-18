export const APP_PROFILES = Object.freeze({
  FULL: "full",
  DIET: "diet",
});

const FULL_PROFILE = APP_PROFILES.FULL;

const CAPABILITIES = Object.freeze({
  [APP_PROFILES.FULL]: Object.freeze({
    profile: APP_PROFILES.FULL,
    auth: true,
    search: true,
    requests: true,
    lidarr: true,
    lastfm: true,
    localLibrary: true,
    downloads: true,
    playback: true,
    flows: true,
    backgroundWorkers: true,
    matcher: true,
  }),
  [APP_PROFILES.DIET]: Object.freeze({
    profile: APP_PROFILES.DIET,
    auth: true,
    search: true,
    requests: true,
    lidarr: true,
    lastfm: true,
    localLibrary: false,
    downloads: false,
    playback: false,
    flows: false,
    backgroundWorkers: false,
    matcher: false,
  }),
});

export function resolveAppProfile(env = process.env) {
  return String(env?.AURRAL_PROFILE || "").trim().toLowerCase() === APP_PROFILES.DIET
    ? APP_PROFILES.DIET
    : FULL_PROFILE;
}

export const APP_PROFILE = resolveAppProfile();

export function getAppCapabilities(profile = APP_PROFILE) {
  const normalizedProfile = resolveAppProfile({ AURRAL_PROFILE: profile });
  return { ...CAPABILITIES[normalizedProfile] };
}

export const APP_CAPABILITIES = Object.freeze(getAppCapabilities());

export function hasAppCapability(capability, profile = APP_PROFILE) {
  return getAppCapabilities(profile)[capability] === true;
}
