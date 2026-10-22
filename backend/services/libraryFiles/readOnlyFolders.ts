import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../../config/db-sqlite.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { enqueueSystemTaskJob } from "../honkerDb.ts";
import { lidarrClient } from "../lidarrClient.ts";
import {
  activeLidarrRoots,
  isPathWithin,
  readOnlyFolderPaths,
  saveReadOnlyFolderPaths,
} from "../libraryFolders.ts";
import {
  getLibraryScanStatus,
  getScheduledLibraryScanJobId,
  scheduleLibraryScan,
} from "../libraryScanWorker.ts";

export class ReadOnlyFolderError extends Error {
  declare code: "READ_ONLY_FOLDER_INVALID";

  constructor(message: string) {
    super(message);
    this.code = "READ_ONLY_FOLDER_INVALID";
  }
}

const realPath = (value: string) => fs.realpath(value).catch(() => path.resolve(value));

async function resolveNewFolder(requested: unknown) {
  const value = String(requested || "").trim();
  if (!value || !path.isAbsolute(value)) {
    throw new ReadOnlyFolderError("Enter the full path of the folder.");
  }
  const stat = await fs.stat(value).catch(() => null);
  if (!stat) throw new ReadOnlyFolderError("The folder does not exist, or Aurral cannot see it.");
  if (!stat.isDirectory()) throw new ReadOnlyFolderError("Choose a folder, not a file.");
  try {
    await fs.access(value, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new ReadOnlyFolderError("Aurral cannot read this folder. Check its permissions.");
  }
  const folder = await fs.realpath(value);
  const downloadRoot = await realPath(resolveDownloadRoot());
  if (isPathWithin(downloadRoot, folder)) {
    throw new ReadOnlyFolderError(
      "This folder is in the Downloads Folder, which Aurral manages. Choose a folder outside it.",
    );
  }
  if (isPathWithin(folder, downloadRoot)) {
    throw new ReadOnlyFolderError(
      "The Downloads Folder is inside this folder. Choose a folder that does not contain it.",
    );
  }
  for (const existing of readOnlyFolderPaths()) {
    if (existing === folder) throw new ReadOnlyFolderError("This folder is already in the list.");
    if (isPathWithin(existing, folder) || isPathWithin(folder, existing)) {
      throw new ReadOnlyFolderError(
        `This folder overlaps ${existing}, which is already in the list.`,
      );
    }
  }
  return folder;
}

const countTracksStmt = db
  .prepare<[string, number, string], number>(
    `SELECT COUNT(DISTINCT track_id) FROM library_media_files
   WHERE source = 'readonly' AND available = 1
     AND (path = ? OR substr(path, 1, ?) = ?)`,
  )
  .pluck();

async function describeFolder(folder: string, lidarrRoots: string[]) {
  const prefix = folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`;
  const readable = await fs.access(folder, fsConstants.R_OK | fsConstants.X_OK).then(
    () => true,
    () => false,
  );
  return {
    path: folder,
    readable,
    tracks: countTracksStmt.get(folder, prefix.length, prefix)!,
    lidarrRoot: lidarrRoots.find((root) => isPathWithin(root, folder)) || null,
  };
}

function isLibraryScanActive() {
  const jobId = getScheduledLibraryScanJobId();
  const status = jobId == null ? null : getLibraryScanStatus(jobId)?.status;
  return status === "queued" || status === "running";
}

export async function describeReadOnlyFolders() {
  const lidarrRoots = activeLidarrRoots(lidarrClient);
  return {
    folders: await Promise.all(
      readOnlyFolderPaths().map((folder) => describeFolder(folder, lidarrRoots)),
    ),
    scanning: isLibraryScanActive(),
  };
}

async function applyFolderChange(folders: string[]) {
  saveReadOnlyFolderPaths(folders);
  scheduleLibraryScan({ includeLidarr: true });
  const { refreshLibraryFileWatcher } = await import("../libraryFileWatcher.ts");
  await refreshLibraryFileWatcher();
}

export async function addReadOnlyFolder(requested: unknown) {
  const folder = await resolveNewFolder(requested);
  await applyFolderChange([...readOnlyFolderPaths(), folder]);
  return describeReadOnlyFolders();
}

export async function removeReadOnlyFolder(requested: unknown) {
  const folder = path.resolve(String(requested || "").trim() || "/");
  const folders = readOnlyFolderPaths();
  if (!folders.includes(folder)) {
    throw new ReadOnlyFolderError("This folder is not in the list.");
  }
  await applyFolderChange(folders.filter((entry) => entry !== folder));
  enqueueSystemTaskJob({ kind: "read-only-folder-release", folders: [folder] });
  return describeReadOnlyFolders();
}
