import { listArtistAlbums } from "./providers/brainzmashProvider.js";

const AURRAL_MONITOR_MODES = new Set(["none", "all", "missing", "latest", "first", "future"]);
const ELIGIBLE_RELEASE_TYPES = new Set(["album", "ep"]);

export function resolveAurralMonitorMode(value) {
  const mode = String(value ?? "none").trim().toLowerCase() || "none";
  if (AURRAL_MONITOR_MODES.has(mode)) return { mode };
  return {
    error: `Aurral monitoring does not support the "${mode}" mode`,
    statusCode: 400,
    code: "unsupported_monitor_mode",
  };
}

export function isEligibleAurralRelease(release) {
  const type = String(release?.type || "").trim().toLowerCase();
  if (!ELIGIBLE_RELEASE_TYPES.has(type)) return false;
  if (Array.isArray(release.secondaryTypes) && release.secondaryTypes.length > 0) return false;
  const statuses = Array.isArray(release.releaseStatuses) ? release.releaseStatuses : [];
  return statuses.length === 0 || statuses.includes("Official");
}

const releaseDate = (release) => String(release?.firstReleaseDate || "").trim();

export function selectAurralReleases(releases, mode, { monitorStartedAt = null } = {}) {
  const dated = releases
    .filter((release) => releaseDate(release))
    .sort((left, right) => releaseDate(left).localeCompare(releaseDate(right)));
  switch (mode) {
    case "all":
    case "missing":
      return [...dated, ...releases.filter((release) => !releaseDate(release))];
    case "latest":
      return dated.slice(-1);
    case "first":
      return dated.slice(0, 1);
    case "future": {
      if (!monitorStartedAt) return [];
      const startDate = new Date(monitorStartedAt).toISOString().slice(0, 10);
      return dated.filter((release) => releaseDate(release) > startDate);
    }
    default:
      return [];
  }
}

export async function listAurralArtistReleases(artistMbid) {
  const releases = await listArtistAlbums(artistMbid, { hydrateLimit: 100 });
  return releases.filter(isEligibleAurralRelease);
}
