import fs from "node:fs";
import path from "node:path";

import { resolvePlaylistRoot } from "./playlistPaths.js";
import { isLibraryScanExcludedDirectory } from "./libraryFileScanner.js";
import { lidarrClient } from "./lidarrClient.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

const DEFAULT_DEBOUNCE_MS = 2000;

function isIgnoredChange(root, filename) {
  if (filename == null || filename === "") return false;
  const changedPath = path.isAbsolute(String(filename))
    ? path.resolve(String(filename))
    : path.resolve(root, String(filename));
  const relative = path.relative(path.resolve(root), changedPath);
  const firstSegment = relative.split(path.sep).find(Boolean);
  return isLibraryScanExcludedDirectory(firstSegment);
}

export function createLibraryFileWatcher({
  roots = [],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  watchImpl = fs.watch,
  onChange = () => scheduleLibraryScan(),
  onError = () => {},
} = {}) {
  const watchers = [];
  let timer = null;
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(String(root || ""))).filter(Boolean))];

  const scheduleChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, Math.max(0, Number(debounceMs) || 0));
    timer.unref?.();
  };

  for (const root of uniqueRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = watchImpl(root, { recursive: true }, (_eventType, filename) => {
        if (!isIgnoredChange(root, filename)) scheduleChange();
      });
      watchers.push(watcher);
    } catch (error) {
      onError(error, root);
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) watcher.close();
    },
  };
}

async function resolveLibraryWatchRoots() {
  const roots = [resolvePlaylistRoot()];
  if (lidarrClient.isConfigured()) {
    try {
      const rootFolders = await lidarrClient.getRootFolders();
      roots.push(
        ...(Array.isArray(rootFolders)
          ? rootFolders.map((folder) => resolveLocalPath(folder?.path, getPathMappings("lidarr")))
          : []),
      );
    } catch {}
  }
  return roots.filter(Boolean);
}

let watcherStarted = false;
let activeWatcher = null;

export async function refreshLibraryFileWatcher({ logger = console } = {}) {
  if (!watcherStarted) return false;
  activeWatcher?.close();
  activeWatcher = createLibraryFileWatcher({
    roots: await resolveLibraryWatchRoots(),
    onError: (error, root) => {
      logger.warn?.(`[Library] Failed to watch ${root}:`, error?.message || error);
    },
  });
  return true;
}

export async function startLibraryFileWatcher({ logger = console } = {}) {
  if (watcherStarted) return false;
  watcherStarted = true;
  await refreshLibraryFileWatcher({ logger });
  return true;
}

export function stopLibraryFileWatcher() {
  watcherStarted = false;
  activeWatcher?.close();
  activeWatcher = null;
}
