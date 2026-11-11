import { readdirSync, type Dirent } from "fs";
import path from "path";
import {
  getStoredDownloadFolderPath,
  resolveDefaultDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.ts";
import { buildTrackFileName, sanitizePathPart } from "./downloadUtils.ts";

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

export function buildTrackDestination(
  playlistId: string | null | undefined,
  artistDir: string | null | undefined,
  albumDir: string | null | undefined,
  { ephemeral = false, root }: { ephemeral?: boolean; root?: string | null } = {},
) {
  const artist = String(artistDir || "Unknown Artist");
  const album = String(albumDir || "Unknown Album");
  if (ephemeral) return path.posix.join(AURRAL_FLOWS_DIR, String(playlistId || ""), artist, album);
  const base = root || resolveDownloadRoot();
  const artistName = existingFolderName(base, artist);
  return path.posix.join(artistName, existingFolderName(path.join(base, artistName), album));
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
) {
  return path.resolve(
    root,
    buildTrackDestination(
      null,
      sanitizePathPart(track?.artistName, "Unknown Artist"),
      sanitizePathPart(track?.albumName, "Unknown Album"),
      { root },
    ),
    buildTrackFileName(track, String(ext || "").toLowerCase()),
  );
}

export function isPathInsideRoot(candidatePath: string, rootPath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
