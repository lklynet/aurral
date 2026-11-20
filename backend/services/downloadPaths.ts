import { readdirSync, type Dirent } from "fs";
import path from "path";
import { db } from "../config/db-sqlite.ts";
import type { LibraryAlbumsRow, LibraryMediaFilesRow } from "../db/rows.ts";
import {
  getStoredDownloadFolderPath,
  resolveDefaultDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.ts";
import { buildTrackFileName, sanitizePathPart } from "./downloadUtils.ts";
import { readLibraryMetadata } from "./libraryMetadata.ts";

export const PLAYLIST_FILES_DIR = "_playlists";
export const AURRAL_FLOWS_DIR = "_flows";
export const LEGACY_PLAYLIST_DIR = "aurral-weekly-flow";

function defaultPlaylistRoot() {
  return resolveDefaultDownloadRoot();
}

export function resolveDownloadRoot(explicitRoot?: string | null) {
  const override = String(explicitRoot ?? "").trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }

  const stored = getStoredDownloadFolderPath();
  if (stored) {
    return path.isAbsolute(stored) ? stored : path.resolve(process.cwd(), stored);
  }

  const envDownloadFolder = resolveEnvDownloadFolder();
  if (envDownloadFolder) {
    return envDownloadFolder;
  }

  return defaultPlaylistRoot();
}

const folderKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-");

function existingEntryName(directory: string, name: string, isKind: (entry: Dirent) => boolean) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((entry) => entry.name === name && isKind(entry))) return name;
  const key = folderKey(name);
  return (
    entries
      .filter((entry) => isKind(entry) && folderKey(entry.name) === key)
      .map((entry) => entry.name)
      .sort()[0] || null
  );
}

// Names that differ only in case or quote and dash style are one folder, so a
// change in how a name is written never starts a second folder beside it.
const existingFolderName = (directory: string, name: string) =>
  existingEntryName(directory, name, (entry) => entry.isDirectory()) || name;

// The file already at this name, however its case or quotes are written.
export function findLibraryFileVariant(filePath: string) {
  const name = existingEntryName(
    path.dirname(filePath),
    path.basename(filePath),
    (entry) => !entry.isDirectory(),
  );
  return name ? path.join(path.dirname(filePath), name) : null;
}

export const libraryPathKey = (filePath: string) => folderKey(path.resolve(filePath));

type FolderAlbum = Pick<LibraryAlbumsRow, "id" | "artist_id" | "title" | "release_group_mbid">;

const groupAlbumStmt = db.prepare<[string, string, string], FolderAlbum>(
  `SELECT id, artist_id, title, release_group_mbid FROM library_albums
   WHERE release_group_mbid = ? OR mbid = ?
   ORDER BY release_group_mbid = ? DESC, id
   LIMIT 1`,
);
const artistAlbumsStmt = db.prepare<
  [number],
  Pick<LibraryAlbumsRow, "id" | "title" | "release_group_mbid">
>("SELECT id, title, release_group_mbid FROM library_albums WHERE artist_id = ?");
const albumDetailsStmt = db.prepare<
  [number],
  Pick<LibraryAlbumsRow, "release_date" | "metadata_json">
>("SELECT release_date, metadata_json FROM library_albums WHERE id = ?");
const albumFilesStmt = db.prepare<[number], Pick<LibraryMediaFilesRow, "path">>(
  "SELECT path FROM library_media_files WHERE album_id = ? AND source = 'aurral' AND available = 1",
);

const albumDirName = (title: unknown) => sanitizePathPart(title, "Unknown Album");

function homeFolder(albumId: number) {
  const counts = new Map<string, number>();
  for (const file of albumFilesStmt.all(albumId)) {
    const name = path.basename(path.dirname(file.path));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    [...counts].toSorted(([a, left], [b, right]) => right - left || a.localeCompare(b))[0]?.[0] ??
    null
  );
}

// Albums of one artist that share a title each get a folder. An album keeps
// the folder that holds its files, the oldest album first when two share
// one. Any other takes the title, then the title with its year, or with its
// disambiguation when another of them came out that year. Returns null when
// the album has no namesake, so its folder keeps today's name.
function sameTitleFolder(album: FolderAlbum) {
  const group = album.release_group_mbid;
  if (!group) return null;
  const title = albumDirName(album.title);
  const key = folderKey(title);
  const named = artistAlbumsStmt
    .all(album.artist_id)
    .filter(
      (row) =>
        (row.id === album.id || (row.release_group_mbid && row.release_group_mbid !== group)) &&
        folderKey(albumDirName(row.title)) === key,
    );
  if (named.length < 2) return null;
  const albums = named
    .map((row) => {
      const details = albumDetailsStmt.get(row.id);
      const metadata = readLibraryMetadata(details?.metadata_json);
      return {
        id: row.id,
        home: homeFolder(row.id),
        aurral: row.id === album.id || metadata?.librarySource === "aurral",
        year: /^\d{4}/.exec(details?.release_date ?? "")?.[0] ?? null,
        disambiguation: sanitizePathPart(metadata?.disambiguation, "") || null,
      };
    })
    .filter((entry) => entry.home || entry.aurral)
    .toSorted((left, right) => left.id - right.id);
  if (albums.length < 2) return null;
  const titled = (name: string) => {
    const nameKey = folderKey(name);
    return nameKey === key || nameKey.startsWith(`${key} (`);
  };
  const held = new Set<string>();
  const folders = new Map<number, string>();
  for (const entry of albums) {
    if (!entry.home || !titled(entry.home) || held.has(folderKey(entry.home))) continue;
    held.add(folderKey(entry.home));
    folders.set(entry.id, entry.home);
  }
  for (const entry of albums) {
    if (folders.has(entry.id)) continue;
    const sharedYear =
      entry.year && albums.some((other) => other !== entry && other.year === entry.year);
    const suffixes = sharedYear
      ? [entry.disambiguation, entry.year]
      : [entry.year, entry.disambiguation];
    const free = [
      title,
      ...suffixes.flatMap((suffix) => (suffix ? [`${title} (${suffix})`] : [])),
    ].find((name) => !held.has(folderKey(name)));
    if (free) held.add(folderKey(free));
    folders.set(entry.id, free ?? (entry.home && titled(entry.home) ? entry.home : title));
  }
  return folders.get(album.id) ?? null;
}

// The album is a Library album, or the release group or release MBID of one.
export type LibraryFolderAlbum = FolderAlbum | string | null | undefined;

function libraryAlbumFolder(album: LibraryFolderAlbum) {
  const mbid = typeof album === "string" ? album.trim().toLowerCase() : "";
  const row = typeof album === "string" ? groupAlbumStmt.get(mbid, mbid, mbid) : album;
  return row ? sameTitleFolder(row) : null;
}

export function buildTrackDestination(
  playlistId: string | null | undefined,
  artistDir: string | null | undefined,
  albumDir: string | null | undefined,
  {
    ephemeral = false,
    root,
    album,
  }: { ephemeral?: boolean; root?: string | null; album?: LibraryFolderAlbum } = {},
) {
  const artist = String(artistDir || "Unknown Artist");
  const named = String(albumDir || "Unknown Album");
  if (ephemeral) return path.posix.join(AURRAL_FLOWS_DIR, String(playlistId || ""), artist, named);
  const base = root || resolveDownloadRoot();
  const artistName = existingFolderName(base, artist);
  return path.posix.join(
    artistName,
    existingFolderName(path.join(base, artistName), libraryAlbumFolder(album) ?? named),
  );
}

// The Library's naming: Artist/Album/07 - Title.ext, or 2-07 - Title.ext past
// the first disc, under the Library folder.
export function buildLibraryTrackPath(
  root: string,
  track: {
    artistName?: string | null;
    albumName?: string | null;
    trackName?: string | null;
    trackNumber?: number | null;
    discNumber?: number | null;
  },
  ext: string,
  album?: LibraryFolderAlbum,
) {
  return path.resolve(
    root,
    buildTrackDestination(
      null,
      sanitizePathPart(track?.artistName, "Unknown Artist"),
      albumDirName(track?.albumName),
      { root, album },
    ),
    buildTrackFileName(track, String(ext || "").toLowerCase()),
  );
}

export function isPathInsideRoot(candidatePath: string, rootPath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
