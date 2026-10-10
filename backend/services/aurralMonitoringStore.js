import { db } from "../config/db-sqlite.js";
import {
  DEFAULT_MONITORING,
  legacyMonitorMode,
  resolveArtistMonitoring,
  storedRules,
} from "./aurralMonitoring.js";
import { getLibraryManagementEntry, setLibraryManagement } from "./libraryManagementStore.js";
import { getNormalizedText } from "./providers/brainzmashRanking.js";

const DEFAULTS_KEY = "monitoringDefaults";

const readSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?").pluck();
const writeSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

export function getMonitoringDefaults() {
  let stored = null;
  try {
    stored = JSON.parse(readSettingStmt.get(DEFAULTS_KEY) || "null");
  } catch {}
  if (!stored || typeof stored !== "object") return DEFAULT_MONITORING;
  return {
    rules: storedRules(stored.rules),
    updatedAt: Number(stored.updatedAt) || 0,
    newReleasesSince: Number(stored.newReleasesSince) || 0,
  };
}

export function saveMonitoringDefaults(defaults) {
  writeSettingStmt.run(DEFAULTS_KEY, JSON.stringify(defaults));
}

export function getStoredArtistMonitoring(artistId) {
  const entry = getLibraryManagementEntry("artist", artistId);
  return entry?.managedBy === "aurral" ? entry.monitorRules || null : null;
}

export function getAurralArtistMonitoring(artistId, defaults = getMonitoringDefaults()) {
  return resolveArtistMonitoring(getStoredArtistMonitoring(artistId), defaults);
}

export function setAurralArtistMonitoringState(artistId, stored, defaults = getMonitoringDefaults()) {
  return setLibraryManagement({
    entityKind: "artist",
    entityId: artistId,
    managedBy: "aurral",
    monitorMode: legacyMonitorMode(resolveArtistMonitoring(stored, defaults)),
    monitorRules: stored,
  });
}

const insertExclusionStmt = db.prepare(`
  INSERT INTO library_monitoring_exclusions
    (kind, exclusion_key, mbid, artist_mbid, artist_name, title, normalized_title, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (kind, exclusion_key) DO UPDATE SET
    title = excluded.title,
    artist_name = COALESCE(excluded.artist_name, library_monitoring_exclusions.artist_name)
`);

const EXCLUSION_COLUMNS = `
  id, kind, mbid, artist_mbid AS artistMbid, artist_name AS artistName, title,
  normalized_title AS normalizedTitle, created_at AS createdAt
`;

const listExclusionsStmt = db.prepare(
  `SELECT ${EXCLUSION_COLUMNS} FROM library_monitoring_exclusions ORDER BY created_at DESC, id DESC`,
);
const listArtistExclusionsStmt = db.prepare(
  `SELECT ${EXCLUSION_COLUMNS} FROM library_monitoring_exclusions
   WHERE artist_mbid = ? ORDER BY created_at DESC, id DESC`,
);
const deleteExclusionStmt = db.prepare("DELETE FROM library_monitoring_exclusions WHERE id = ?");
const deleteArtistExclusionsStmt = db.prepare(
  "DELETE FROM library_monitoring_exclusions WHERE artist_mbid = ?",
);
const albumExclusionStmt = db.prepare(
  "SELECT 1 FROM library_monitoring_exclusions WHERE kind = 'album' AND mbid = ?",
);
const deleteAlbumExclusionStmt = db.prepare(
  "DELETE FROM library_monitoring_exclusions WHERE kind = 'album' AND mbid = ?",
);
const deleteTrackExclusionStmt = db.prepare(`
  DELETE FROM library_monitoring_exclusions
  WHERE kind = 'track'
    AND ((? IS NOT NULL AND mbid = ?)
      OR (normalized_title = ? AND (artist_mbid = ? OR artist_name = ?)))
`);

const normalizedTitle = (title) => getNormalizedText(title);
const trimmed = (value) => String(value || "").trim() || null;

export function addMonitoringExclusion({ kind, mbid = null, artistMbid = null, artistName = null, title }) {
  const name = trimmed(title);
  const id = trimmed(mbid);
  if (!["album", "track"].includes(kind) || !name || (kind === "album" && !id)) return false;
  const key = id || `${trimmed(artistMbid) || getNormalizedText(artistName)}:${normalizedTitle(name)}`;
  insertExclusionStmt.run(
    kind,
    key,
    id,
    trimmed(artistMbid),
    trimmed(artistName),
    name,
    normalizedTitle(name),
    Date.now(),
  );
  return true;
}

export const listMonitoringExclusions = ({ artistMbid = null } = {}) =>
  artistMbid ? listArtistExclusionsStmt.all(artistMbid) : listExclusionsStmt.all();

export const removeMonitoringExclusion = (id) => deleteExclusionStmt.run(Number(id)).changes > 0;

export const clearArtistMonitoringExclusions = (artistMbid) =>
  artistMbid ? deleteArtistExclusionsStmt.run(artistMbid).changes : 0;

export const isAlbumMonitoringExcluded = (albumMbid) =>
  Boolean(albumMbid && albumExclusionStmt.get(albumMbid));

export const clearAlbumMonitoringExclusion = (albumMbid) =>
  albumMbid ? deleteAlbumExclusionStmt.run(albumMbid).changes > 0 : false;

export function clearTrackMonitoringExclusion({ mbid = null, artistMbid = null, artistName = null, title }) {
  const id = trimmed(mbid);
  return deleteTrackExclusionStmt.run(
    id,
    id,
    normalizedTitle(title),
    trimmed(artistMbid),
    trimmed(artistName),
  ).changes > 0;
}

export function indexArtistExclusions(artistMbid) {
  const exclusions = listMonitoringExclusions({ artistMbid });
  const albums = new Set(exclusions.filter((entry) => entry.kind === "album").map((entry) => entry.mbid));
  const tracks = exclusions.filter((entry) => entry.kind === "track");
  const trackMbids = new Set(tracks.map((entry) => entry.mbid).filter(Boolean));
  const trackTitles = new Set(tracks.map((entry) => entry.normalizedTitle));
  return {
    isAlbumExcluded: (mbid) => albums.has(mbid),
    isTrackExcluded: ({ mbid, title }) =>
      (Boolean(mbid) && trackMbids.has(mbid)) || trackTitles.has(normalizedTitle(title)),
  };
}
