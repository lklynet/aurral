import * as v from "valibot";
import fs from "node:fs/promises";
import path from "node:path";
import { dbOps, userOps } from "../../db/helpers/index.ts";

export const PLAYLIST_FILE_EXTENSION = ".m3u";
const WRITTEN_FILES_KEY = "playlistFileNames";

const writtenFilesSchema = v.record(v.string(), v.string());

export type PlaylistFileTrack = {
  path: string;
  title: string;
  artist: string;
  durationMs?: number;
};
type NamedEntity = { id: string; name: string; ownerUserId?: number | null; createdAt: number };

export const sanitizePlaylistFileName = (value: string) =>
  value.replace(/[<>:"/\\|?*]/g, "_").trim();

function prefixedName(entity: NamedEntity) {
  const owner = entity.ownerUserId == null ? null : userOps.getUserById(entity.ownerUserId);
  return owner?.username ? `${owner.username} - ${entity.name}` : entity.name;
}

const fileKey = (name: string) => sanitizePlaylistFileName(name).toLowerCase();

// Every playlist needs its own file, and a file keeps its name when another
// user later picks the same one: the oldest owner of a name keeps it bare,
// newer owners get their username, and any name still taken gets a number.
export function playlistDisplayNames(entities: readonly NamedEntity[]) {
  const firstOwner = new Map<string, number | null>();
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const oldestFirst = [...entities].sort((left, right) => left.createdAt - right.createdAt);
  for (const entity of oldestFirst) {
    const key = fileKey(entity.name);
    const owner = entity.ownerUserId ?? null;
    if (!firstOwner.has(key)) firstOwner.set(key, owner);
    const name = firstOwner.get(key) === owner ? entity.name : prefixedName(entity);
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
