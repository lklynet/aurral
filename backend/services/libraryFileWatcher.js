import fs from "node:fs";
import path from "node:path";

import { resolvePlaylistRoot } from "./playlistPaths.js";
import { AUDIO_EXTENSIONS, isLibraryScanExcludedDirectory } from "./libraryFileScanner.js";
import { lidarrClient } from "./lidarrClient.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

// Lidarr writes album folders in bursts (files, artwork, nfo, temp names), so
// a change only schedules a scan once the roots have been quiet for a while.
const durationSetting = (name, fallback) => {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
};
const DEFAULT_DEBOUNCE_MS = durationSetting("LIBRARY_WATCH_DEBOUNCE_MS", 2 * 60 * 1000);
// A long import (a whole discography, a large tag rewrite) never goes quiet
// for the debounce window, so a burst is flushed after this long regardless.
const DEFAULT_MAX_WAIT_MS = durationSetting("LIBRARY_WATCH_MAX_WAIT_MS", 10 * 60 * 1000);

const isExistingDirectory = (candidate) => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

// Directories still count: a moved or removed album folder only reports the
// directory itself, and a folder named like "Mr. Bungle" or "Vol. 2" has what
// looks like an extension, so a path that exists as a directory is never
// ignored.
export function isIgnoredChange(root, filename) {
  if (filename == null || filename === "") return false;
  const changedPath = path.isAbsolute(String(filename))
    ? path.resolve(String(filename))
    : path.resolve(root, String(filename));
  const relative = path.relative(path.resolve(root), changedPath);
  const firstSegment = relative.split(path.sep).find(Boolean);
  if (isLibraryScanExcludedDirectory(firstSegment)) return true;
  const baseName = path.basename(changedPath);
  if (baseName.startsWith(".")) return true;
  const extension = path.extname(baseName).toLowerCase();
  if (!extension || AUDIO_EXTENSIONS.has(extension)) return false;
  return !isExistingDirectory(changedPath);
}

export function createLibraryFileWatcher({
  roots = [],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  watchImpl = fs.watch,
  onChange = () => scheduleLibraryScan(),
  onError = () => {},
} = {}) {
  const watchers = [];
  let timer = null;
  let maxWaitTimer = null;
  const changedRoots = new Set();
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(String(root || ""))).filter(Boolean))];

  const flush = () => {
    if (timer) clearTimeout(timer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    timer = null;
    maxWaitTimer = null;
    const roots = [...changedRoots];
    changedRoots.clear();
    if (roots.length) onChange(roots);
  };

  const scheduleChange = (root) => {
    changedRoots.add(root);
    // The quiet timer restarts on every change; the max-wait timer starts with
    // the first change of a burst and is not restarted.
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Number(debounceMs) || 0));
    timer.unref?.();
    const maxWait = Number(maxWaitMs);
    if (!maxWaitTimer && Number.isFinite(maxWait) && maxWait > 0) {
      maxWaitTimer = setTimeout(flush, maxWait);
      maxWaitTimer.unref?.();
    }
  };

  for (const root of uniqueRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = watchImpl(root, { recursive: true }, (_eventType, filename) => {
        if (!isIgnoredChange(root, filename)) scheduleChange(root);
      });
      watchers.push(watcher);
    } catch (error) {
      onError(error, root);
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
      timer = null;
      maxWaitTimer = null;
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
  const playlistRoot = path.resolve(resolvePlaylistRoot());
  activeWatcher = createLibraryFileWatcher({
    roots: await resolveLibraryWatchRoots(),
    onChange: (changedRoots) => scheduleLibraryScan({
      includeLidarr: changedRoots.some((root) => path.resolve(root) !== playlistRoot),
    }),
    onError: (error, root) => {
      logger.warn?.(`[Library] Failed to watch ${root}:`, error?.message || error);
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
