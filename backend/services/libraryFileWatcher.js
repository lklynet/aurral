import path from "node:path";

import { resolvePlaylistRoot } from "./playlistPaths.js";
import { isLibraryScanExcludedDirectory } from "./libraryFileScanner.js";
import { lidarrClient } from "./lidarrClient.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import { getPathMappings } from "./pathMappings.js";
import { createIsolatedLibraryWatcher } from "./libraryWatchProcess.js";

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
  watchImpl = createIsolatedLibraryWatcher,
  onChange = (_roots, changedPaths) => scheduleLibraryScan({ changedPaths }),
  onError = () => {},
} = {}) {
  const watchers = new Set();
  const activeRoots = new Map();
  let closed = false;
  let timer = null;
  const changedRoots = new Set();
  const changedPaths = new Set();
  const watchRoots = new Map();
  for (const entry of roots) {
    const root = String(entry?.path ?? entry ?? "");
    if (!root) continue;
    const key = path.resolve(root);
    if (!watchRoots.has(key)) watchRoots.set(key, { root, pathMappings: entry?.pathMappings || [] });
  }

  const scheduleChange = (root, filename) => {
    if (closed) return;
    changedRoots.add(root);
    changedPaths.add(
      filename == null || filename === ""
        ? root
        : path.isAbsolute(String(filename))
          ? path.resolve(String(filename))
          : path.resolve(root, String(filename)),
    );
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const roots = [...changedRoots];
      const paths = [...changedPaths];
      changedRoots.clear();
      changedPaths.clear();
      onChange(roots, paths);
    }, Math.max(0, Number(debounceMs) || 0));
    timer.unref?.();
  };

  for (const { root, pathMappings } of watchRoots.values()) {
    try {
      let stopped = false;
      let duplicate = false;
      let failureReported = false;
      let resolvedKey = null;
      const watcher = watchImpl(root, { recursive: true, pathMappings }, (_eventType, filename, resolvedRoot = path.resolve(root)) => {
        if (closed || stopped) return;
        if (!isIgnoredChange(resolvedRoot, filename)) scheduleChange(resolvedRoot, filename);
      });
      const releaseRoot = () => {
        stopped = true;
        watchers.delete(watcher);
        if (activeRoots.get(resolvedKey) === watcher) activeRoots.delete(resolvedKey);
      };
      const stopWatcher = () => {
        if (stopped) return;
        releaseRoot();
        watcher.close();
      };
      watchers.add(watcher);
      watcher.on?.("ready", (resolvedRoot) => {
        if (closed || stopped || resolvedKey !== null) return;
        resolvedKey = path.resolve(resolvedRoot);
        if (activeRoots.has(resolvedKey)) {
          duplicate = true;
          stopWatcher();
        } else {
          activeRoots.set(resolvedKey, watcher);
        }
      });
      watcher.on?.("close", releaseRoot);
      watcher.on?.("error", (error) => {
        if (closed || duplicate || failureReported) return;
        failureReported = true;
        stopWatcher();
        onError(error, root);
      });
    } catch (error) {
      onError(error, root);
    }
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      changedRoots.clear();
      changedPaths.clear();
      for (const watcher of watchers) watcher.close();
      watchers.clear();
      activeRoots.clear();
    },
  };
}

export function resolveLibraryWatchRoots() {
  const roots = [resolvePlaylistRoot()];
  if (lidarrClient.isEnabled()) {
    // Path mapping checks whether the original path exists; defer that I/O to
    // the watcher child along with recursive watcher creation.
    roots.push(
      ...lidarrClient
        .getConfiguredRootFolderPaths()
        .filter(Boolean)
        .map((root) => ({ path: root, pathMappings: getPathMappings("lidarr") })),
    );
  }
  return roots.filter(Boolean);
}

let watcherStarted = false;
let activeWatcher = null;

export async function refreshLibraryFileWatcher({ logger = console } = {}) {
  if (!watcherStarted) return false;
  activeWatcher?.close();
  const playlistRoot = path.resolve(resolvePlaylistRoot());
  activeWatcher = createLibraryFileWatcher({
    roots: resolveLibraryWatchRoots(),
    onChange: (changedRoots, changedPaths) => scheduleLibraryScan({
      includeLidarr: changedRoots.some((root) => path.resolve(root) !== playlistRoot),
      changedPaths,
    }),
    onError: (error, root) => {
      logger.warn?.(`[Library] Automatic file watching disabled for ${root}; manual library refresh is still available:`, error?.message || error);
    },
  });
  return true;
}

export async function startLibraryFileWatcher({ logger = console } = {}) {
  if (watcherStarted) return false;
  watcherStarted = true;
  try {
    await refreshLibraryFileWatcher({ logger });
    return true;
  } catch (error) {
    watcherStarted = false;
    activeWatcher?.close();
    activeWatcher = null;
    throw error;
  }
}

export function stopLibraryFileWatcher() {
  watcherStarted = false;
  activeWatcher?.close();
  activeWatcher = null;
}
