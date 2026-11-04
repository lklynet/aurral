import * as v from "valibot";
import fs from "node:fs/promises";
import path from "node:path";
import { dbOps, userOps } from "../../db/helpers/index.ts";

export const PLAYLIST_FILE_EXTENSION = ".m3u";
export const PLAYLIST_FILE_SETTINGS_KEY = "playlistFiles";
const WRITTEN_FILES_KEY = "playlistFileNames";

const playlistFileSettingsSchema = v.looseObject({
  prefixOwnerUsername: v.optional(v.boolean()),
});
const writtenFilesSchema = v.record(v.string(), v.string());

export type PlaylistFileSettings = { prefixOwnerUsername: boolean };
export type PlaylistFileTrack = {
  path: string;
  title: string;
  artist: string;
  durationMs?: number;
};
type NamedEntity = { id: string; name: string; ownerUserId?: number | null };

export function getPlaylistFileSettings(): PlaylistFileSettings {
  const stored = dbOps.getJSONSetting(PLAYLIST_FILE_SETTINGS_KEY, playlistFileSettingsSchema);
  return { prefixOwnerUsername: stored?.prefixOwnerUsername !== false };
}

export function savePlaylistFileSettings(settings: PlaylistFileSettings) {
  dbOps.setJSONSetting(PLAYLIST_FILE_SETTINGS_KEY, settings);
}

export const sanitizePlaylistFileName = (value: string) =>
  value.replace(/[<>:"/\\|?*]/g, "_").trim();

function prefixedName(entity: NamedEntity) {
  const owner = entity.ownerUserId == null ? null : userOps.getUserById(entity.ownerUserId);
  return owner?.username ? `${owner.username} - ${entity.name}` : entity.name;
}

const fileKey = (name: string) => sanitizePlaylistFileName(name).toLowerCase();

// Every playlist needs its own file. Without the owner prefix, playlists of
// different users that share a name keep the prefix, and any name still taken
// gets a number.
export function playlistDisplayNames(
  entities: readonly NamedEntity[],
  { prefixOwnerUsername }: PlaylistFileSettings = getPlaylistFileSettings(),
) {
  const owners = new Map<string, Set<number | null>>();
  for (const entity of entities) {
    const key = fileKey(entity.name);
    owners.set(key, (owners.get(key) ?? new Set()).add(entity.ownerUserId ?? null));
  }
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const entity of entities) {
    const shared = owners.get(fileKey(entity.name))!.size > 1;
    const name = prefixOwnerUsername || shared ? prefixedName(entity) : entity.name;
    let candidate = name;
    for (let count = 2; taken.has(fileKey(candidate)); count += 1) candidate = `${name} (${count})`;
    taken.add(fileKey(candidate));
    names.set(entity.id, candidate);
  }
  return names;
}

export function buildPlaylistFile(tracks: readonly PlaylistFileTrack[]) {
  const lines = ["#EXTM3U"];
  for (const track of tracks) {
    const seconds = Math.max(0, Math.round((track.durationMs ?? 0) / 1000));
    lines.push(`#EXTINF:${seconds},${track.artist} - ${track.title}`);
    lines.push(track.path);
  }
  return `${lines.join("\n")}\n`;
}

export function readWrittenPlaylistFiles() {
  return dbOps.getJSONSetting(WRITTEN_FILES_KEY, writtenFilesSchema) ?? {};
}

export function saveWrittenPlaylistFiles(files: Record<string, string>) {
  dbOps.setJSONSetting(WRITTEN_FILES_KEY, files);
}

export async function writePlaylistFile(filePath: string, content: string, { force = false } = {}) {
  if (!force && (await fs.readFile(filePath, "utf8").catch(() => null)) === content) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filePath);
  return true;
}
