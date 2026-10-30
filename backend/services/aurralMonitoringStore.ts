import * as v from "valibot";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import type { LibraryMonitoringExclusionsRow, SettingsRow } from "../db/rows.ts";
import {
  DEFAULT_MONITORING,
  legacyMonitorMode,
  resolveArtistMonitoring,
  storedRules,
} from "./aurralMonitoring.ts";
import { getLibraryManagementEntry, setLibraryManagement } from "./libraryManagementStore.ts";
import { getNormalizedText } from "./providers/brainzmashRanking.ts";

const DEFAULTS_KEY = "monitoringDefaults";

const readSettingStmt = db
  .prepare<[string], SettingsRow["value"]>("SELECT value FROM settings WHERE key = ?")
  .pluck();
const writeSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

export function getMonitoringDefaults() {
  const stored = dbHelpers.readJSON(
    v.record(v.string(), v.unknown()),
    readSettingStmt.get(DEFAULTS_KEY),
    DEFAULTS_KEY,
  );
  if (!stored) return DEFAULT_MONITORING;
  return {
    rules: storedRules(stored.rules),
    updatedAt: Number(stored.updatedAt) || 0,
    newReleasesSince: Number(stored.newReleasesSince) || 0,
  };
}

export function saveMonitoringDefaults(defaults: ReturnType<typeof getMonitoringDefaults>) {
  writeSettingStmt.run(DEFAULTS_KEY, JSON.stringify(defaults));
}

export function getStoredArtistMonitoring(artistId: string | number) {
  const entry = getLibraryManagementEntry("artist", artistId);
  return entry?.managedBy === "aurral" ? entry.monitorRules || null : null;
}

export function getAurralArtistMonitoring(
  artistId: string | number,
  defaults = getMonitoringDefaults(),
) {
  return resolveArtistMonitoring(getStoredArtistMonitoring(artistId), defaults);
}

export function setAurralArtistMonitoringState(
  artistId: string | number,
  stored: Parameters<typeof resolveArtistMonitoring>[0],
  defaults = getMonitoringDefaults(),
) {
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
    normalized_title = excluded.normalized_title,
    artist_name = COALESCE(excluded.artist_name, library_monitoring_exclusions.artist_name)
`);

const EXCLUSION_COLUMNS = `
  id, kind, mbid, artist_mbid AS artistMbid, artist_name AS artistName, title,
  normalized_title AS normalizedTitle, created_at AS createdAt
`;

export type MonitoringExclusion = Pick<
  LibraryMonitoringExclusionsRow,
  "id" | "kind" | "mbid" | "title"
> & {
  artistMbid: string | null;
  artistName: string | null;
  normalizedTitle: string;
  createdAt: number;
};

const listExclusionsStmt = db.prepare<[], MonitoringExclusion>(
  `SELECT ${EXCLUSION_COLUMNS} FROM library_monitoring_exclusions ORDER BY created_at DESC, id DESC`,
);
const listArtistExclusionsStmt = db.prepare<[string], MonitoringExclusion>(
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

const normalizedTitle = (title: unknown) => getNormalizedText(title);
const trimmed = (value: unknown) => String(value || "").trim() || null;

export function addMonitoringExclusion({
  kind,
  mbid = null,
  artistMbid = null,
  artistName = null,
  title,
}: {
  kind: "album" | "track";
  mbid?: string | null;
  artistMbid?: string | null;
  artistName?: string | null;
  title: string | null | undefined;
}) {
  const name = trimmed(title);
  const id = trimmed(mbid);
  if (!["album", "track"].includes(kind) || !name || (kind === "album" && !id)) return false;
  const key =
    id || `${trimmed(artistMbid) || getNormalizedText(artistName)}:${normalizedTitle(name)}`;
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

export const listMonitoringExclusions = ({
  artistMbid = null,
}: { artistMbid?: string | null } = {}) =>
  artistMbid ? listArtistExclusionsStmt.all(artistMbid) : listExclusionsStmt.all();

export const removeMonitoringExclusion = (id: string | number) =>
  deleteExclusionStmt.run(Number(id)).changes > 0;

export const clearArtistMonitoringExclusions = (artistMbid: string | null | undefined) =>
  artistMbid ? deleteArtistExclusionsStmt.run(artistMbid).changes : 0;

export const isAlbumMonitoringExcluded = (albumMbid: string | null | undefined) =>
  Boolean(albumMbid && albumExclusionStmt.get(albumMbid));

export const clearAlbumMonitoringExclusion = (albumMbid: string | null | undefined) =>
  albumMbid ? deleteAlbumExclusionStmt.run(albumMbid).changes > 0 : false;

export function clearTrackMonitoringExclusion({
  mbid = null,
  artistMbid = null,
  artistName = null,
  title,
}: {
  mbid?: string | null;
  artistMbid?: string | null;
  artistName?: string | null;
  title: string | null | undefined;
}) {
  const id = trimmed(mbid);
  return (
    deleteTrackExclusionStmt.run(
      id,
      id,
      normalizedTitle(title),
      trimmed(artistMbid),
      trimmed(artistName),
    ).changes > 0
  );
}

export function indexArtistExclusions(artistMbid: string | null | undefined) {
  const exclusions = listMonitoringExclusions({ artistMbid });
  const albums = new Set(
    exclusions.filter((entry) => entry.kind === "album").map((entry) => entry.mbid),
  );
  const tracks = exclusions.filter((entry) => entry.kind === "track");
  const trackMbids = new Set<string | null | undefined>(
    tracks.map((entry) => entry.mbid).filter(Boolean),
  );
  const trackTitles = new Set(tracks.map((entry) => entry.normalizedTitle));
  return {
    isAlbumExcluded: (mbid: string | null) => albums.has(mbid),
    isTrackExcluded: ({
      mbid,
      title,
    }: {
      mbid?: string | null;
      title: string | null | undefined;
    }) => (Boolean(mbid) && trackMbids.has(mbid)) || trackTitles.has(normalizedTitle(title)),
  };
}
