import { listArtistAlbums } from "./providers/brainzmashProvider.ts";

export const RELEASE_TYPES = ["album", "ep", "single"];
export const EXTRA_RELEASE_TYPES = [
  "live",
  "compilation",
  "soundtrack",
  "remix",
  "demo",
  "dj-mix",
  "mixtape/street",
];
const CATALOG_SCOPES = new Set(["none", "all", "since", "latest"]);
const EDITIONS = new Set(["standard", "expanded"]);
export const MAX_LATEST_RELEASES = 10;
export const MAX_TOP_TRACKS = 50;

export const FACTORY_MONITOR_RULES = Object.freeze({
  catalog: "all",
  sinceYear: null,
  latestCount: 1,
  newReleases: true,
  types: Object.freeze(["album", "ep"]),
  extraTypes: Object.freeze([]),
  edition: "standard",
  topTracks: 0,
});

export const AURRAL_ALBUM_CONDITION = `
  management.entity_kind = 'album'
  AND management.managed_by = 'aurral'
`;

export const MONITORED_AURRAL_ALBUM_CONDITION = `
  ${AURRAL_ALBUM_CONDITION}
  AND COALESCE(management.monitor_mode, '') != 'unmonitored'
  AND json_valid(album.metadata_json)
  AND json_extract(album.metadata_json, '$.monitored') = 1
`;

export const monitoredTrackCondition = (trackAlias) => `${trackAlias}.monitored = 1`;

const invalidRules = (message) => ({
  error: message,
  statusCode: 400,
  code: "invalid_monitor_rules",
});

const lower = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const isWholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

const pickTypes = (value, allowed) =>
  Array.isArray(value) && value.every((entry) => allowed.includes(lower(entry)))
    ? allowed.filter((type) => value.some((entry) => lower(entry) === type))
    : null;

export function normalizeMonitorRules(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidRules("Monitoring rules must be an object");
  }
  const input = { ...FACTORY_MONITOR_RULES, ...value };
  if (!CATALOG_SCOPES.has(input.catalog))
    return invalidRules("Choose None, Everything, Since a year, or Latest for the back catalogue");
  const lastYear = new Date().getUTCFullYear() + 1;
  const sinceYear = input.catalog === "since" ? Number(input.sinceYear) : null;
  if (input.catalog === "since" && !isWholeNumber(sinceYear, 1900, lastYear)) {
    return invalidRules(`Choose a year between 1900 and ${lastYear}`);
  }
  const latestCount = Number(input.latestCount);
  if (!isWholeNumber(latestCount, 1, MAX_LATEST_RELEASES)) {
    return invalidRules(`Latest must be between 1 and ${MAX_LATEST_RELEASES} releases`);
  }
  if (typeof input.newReleases !== "boolean") return invalidRules("New releases must be on or off");
  const types = pickTypes(input.types, RELEASE_TYPES);
  if (!types?.length) return invalidRules("Choose at least one of Album, EP, or Single");
  const extraTypes = pickTypes(input.extraTypes, EXTRA_RELEASE_TYPES);
  if (!extraTypes) return invalidRules("Unknown release type");
  if (!EDITIONS.has(input.edition))
    return invalidRules("Choose Standard or Expanded for the edition");
  const topTracks = Number(input.topTracks);
  if (!isWholeNumber(topTracks, 0, MAX_TOP_TRACKS)) {
    return invalidRules(`Top tracks must be between 0 and ${MAX_TOP_TRACKS}`);
  }
  if (input.catalog === "none" && !input.newReleases && topTracks === 0) {
    return invalidRules("Choose a back catalogue, new releases, or top tracks to monitor");
  }
  return {
    rules: {
      catalog: input.catalog,
      sinceYear,
      latestCount,
      newReleases: input.newReleases,
      types,
      extraTypes,
      edition: input.edition,
      topTracks,
    },
  };
}

export const storedRules = (value) =>
  normalizeMonitorRules(value).rules || { ...FACTORY_MONITOR_RULES };

export const sameRules = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function releaseMatchesRules(release, rules) {
  if (!rules.types.includes(lower(release?.type))) return false;
  const secondaryTypes = Array.isArray(release.secondaryTypes) ? release.secondaryTypes : [];
  if (!secondaryTypes.every((type) => rules.extraTypes.includes(lower(type)))) return false;
  const statuses = Array.isArray(release.releaseStatuses) ? release.releaseStatuses : [];
  return statuses.length === 0 || statuses.includes("Official");
}

export const isStudioAlbum = (release) =>
  lower(release?.type) === "album" && !(release.secondaryTypes?.length > 0);

const releaseDate = (release) => String(release?.firstReleaseDate || "").trim();

const isoDay = (timestamp) => new Date(Number(timestamp) || 0).toISOString().slice(0, 10);

// The back catalogue is what was out when the rules were saved, so "Latest 3"
// stays three releases. New releases are those dated after monitoring of new
// releases began.
export function selectMonitoredReleases(releases, rules, { catalogAt, newSince }) {
  const matching = releases.filter((release) => releaseMatchesRules(release, rules));
  const dated = matching
    .filter(releaseDate)
    .sort((left, right) => releaseDate(left).localeCompare(releaseDate(right)));
  const catalogDay = isoDay(catalogAt);
  const released = dated.filter((release) => releaseDate(release) <= catalogDay);
  const catalog = {
    all: () => [...released, ...matching.filter((release) => !releaseDate(release))],
    since: () =>
      released.filter((release) => Number(releaseDate(release).slice(0, 4)) >= rules.sinceYear),
    latest: () => released.slice(-rules.latestCount),
    none: () => [],
  }[rules.catalog]();
  const newDay = isoDay(newSince);
  const fresh = rules.newReleases ? dated.filter((release) => releaseDate(release) > newDay) : [];
  const selected = new Map([...catalog, ...fresh].map((release) => [release.id, release]));
  return [...selected.values()].sort(
    (left, right) =>
      Number(isStudioAlbum(right)) - Number(isStudioAlbum(left)) ||
      (releaseDate(left) || "9999").localeCompare(releaseDate(right) || "9999"),
  );
}

export const DEFAULT_MONITORING = Object.freeze({
  rules: FACTORY_MONITOR_RULES,
  updatedAt: 0,
  newReleasesSince: 0,
});

// An artist that uses the default follows later changes to it from the
// moment of each change, the same as if its own rules had been saved then.
export function resolveArtistMonitoring(stored, defaults = DEFAULT_MONITORING) {
  if (!stored || typeof stored !== "object") return null;
  const catalogAt = Number(stored.catalogAt) || 0;
  const newSince = Number(stored.newSince) || 0;
  if (stored.default === true) {
    return {
      useDefault: true,
      rules: defaults.rules,
      catalogAt: Math.max(catalogAt, Number(defaults.updatedAt) || 0),
      newSince: Math.max(newSince, Number(defaults.newReleasesSince) || 0),
    };
  }
  return { useDefault: false, rules: storedRules(stored.rules), catalogAt, newSince };
}

export const monitoringToken = (effective) => (effective ? JSON.stringify(effective) : null);

export function nextArtistMonitoring(previous, { useDefault, rules }, defaults, now = Date.now()) {
  const nextRules = useDefault ? defaults.rules : rules;
  const unchanged = previous && sameRules(previous.rules, nextRules);
  const keepNewSince = previous?.rules.newReleases && nextRules.newReleases;
  return {
    default: useDefault,
    ...(useDefault ? {} : { rules: nextRules }),
    catalogAt: unchanged ? previous.catalogAt : now,
    newSince: unchanged || keepNewSince ? previous.newSince : now,
  };
}

export function nextMonitoringDefaults(previous, rules, now = Date.now()) {
  if (sameRules(previous.rules, rules)) return previous;
  return {
    rules,
    updatedAt: now,
    newReleasesSince:
      previous.rules.newReleases && rules.newReleases ? previous.newReleasesSince : now,
  };
}

// Older builds read monitor_mode, so it keeps the closest of their modes.
export function legacyMonitorMode(effective) {
  if (!effective?.rules.newReleases) return "none";
  if (effective.rules.catalog === "all") return "all";
  return effective.rules.catalog === "latest" ? "latest" : "future";
}

// Earlier builds stored one mode per artist. "all" became the default rules;
// "first" never followed new releases, so its album stays and the artist
// stops being monitored.
export function monitoringFromLegacyMode(mode) {
  switch (
    String(mode || "none")
      .trim()
      .toLowerCase()
  ) {
    case "all":
      return { useDefault: true, rules: null };
    case "future":
      return { useDefault: false, rules: { ...FACTORY_MONITOR_RULES, catalog: "none" } };
    case "latest":
      return {
        useDefault: false,
        rules: { ...FACTORY_MONITOR_RULES, catalog: "latest", latestCount: 1 },
      };
    case "none":
      return null;
    default:
      return undefined;
  }
}

export async function listAurralArtistReleases(artistMbid) {
  return listArtistAlbums(artistMbid, { hydrateLimit: 100 });
}
