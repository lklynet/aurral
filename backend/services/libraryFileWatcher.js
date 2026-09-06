import fs from "node:fs";
import path from "node:path";

import { db } from "../config/db-sqlite.js";
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
// A change the watcher cannot map to a known Lidarr artist (a new artist
// folder, a burst too large to track) needs a full Lidarr pull, which is the
// expensive request; the watcher makes at most one per this interval and the
// Lidarr webhook covers the rest.
const DEFAULT_FULL_SCAN_INTERVAL_MS = durationSetting(
  "LIBRARY_WATCH_FULL_SCAN_INTERVAL_MS",
  60 * 60 * 1000,
);
// Changed paths tracked per burst; past this the burst is treated as "anything
// under the root may have changed".
export const MAX_TRACKED_CHANGES = 500;

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
  const changedPaths = new Set();
  let overflow = false;
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(String(root || ""))).filter(Boolean))];

  const flush = () => {
    if (timer) clearTimeout(timer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    timer = null;
    maxWaitTimer = null;
    const roots = [...changedRoots];
    const details = { paths: [...changedPaths], overflow };
    changedRoots.clear();
    changedPaths.clear();
    overflow = false;
    if (roots.length) onChange(roots, details);
  };

  const scheduleChange = (root, filename) => {
    changedRoots.add(root);
    if (changedPaths.size < MAX_TRACKED_CHANGES) {
      changedPaths.add(path.resolve(root, String(filename || "")));
    } else {
      overflow = true;
    }
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
        if (!isIgnoredChange(root, filename)) scheduleChange(root, filename);
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

const isWithin = (candidate, folder) =>
  candidate === folder || candidate.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

// Lidarr artist folders as local paths, from the indexed metadata. Cheap
// (one row per artist) and only read once per flush.
export function loadLidarrArtistFolders(mappings = getPathMappings("lidarr")) {
  const rows = db
    .prepare(
      `SELECT json_extract(metadata_json, '$.id') AS id, json_extract(metadata_json, '$.path') AS path
       FROM library_artists
       WHERE json_extract(metadata_json, '$.librarySource') = 'lidarr'`,
    )
    .all();
  const folders = [];
  for (const row of rows) {
    const id = Number(row.id);
    const localPath = row.path ? resolveLocalPath(String(row.path), mappings) : null;
    if (!Number.isSafeInteger(id) || id <= 0 || !localPath) continue;
    folders.push({ id, localPath: path.resolve(localPath) });
  }
  return folders;
}

// Decides what a flushed burst of changes should schedule. Pure, so the
// policy is testable without a filesystem:
// - changes under the playlist root need a local scan;
// - changes under a Lidarr root that map to known artist folders re-index
//   those artists;
// - anything else under a Lidarr root (new artist folder, untracked burst)
//   needs a full Lidarr pull, allowed once per `fullScanIntervalMs`; when not
//   allowed, the mapped work is still scheduled and `deferFull` says a full
//   pull is owed once the interval has passed.
export function planWatcherScan({
  changedRoots = [],
  paths = [],
  overflow = false,
  playlistRoot,
  lidarrArtistFolders = [],
  lastFullScanAt = 0,
  now = Date.now(),
  fullScanIntervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
}) {
  const resolvedPlaylistRoot = path.resolve(String(playlistRoot || ""));
  const roots = changedRoots.map((root) => path.resolve(String(root || "")));
  const localChanged = roots.includes(resolvedPlaylistRoot);
  const lidarrChanged = roots.some((root) => root !== resolvedPlaylistRoot);
  if (!lidarrChanged) {
    return { requests: localChanged ? [{ includeLidarr: false }] : [], fullScheduled: false, deferFull: false };
  }
  const artistIds = new Set();
  let unresolved = overflow;
  for (const changed of paths) {
    const candidate = path.resolve(String(changed || ""));
    if (isWithin(candidate, resolvedPlaylistRoot)) continue;
    // The deepest matching folder wins, for artists nested under another.
    let match = null;
    for (const folder of lidarrArtistFolders) {
      if (!isWithin(candidate, folder.localPath)) continue;
      if (!match || folder.localPath.length > match.localPath.length) match = folder;
    }
    if (match) artistIds.add(match.id);
    else unresolved = true;
  }
  const fullAllowed = unresolved && now - Number(lastFullScanAt || 0) >= fullScanIntervalMs;
  if (fullAllowed) return { requests: [{ includeLidarr: true }], fullScheduled: true, deferFull: false };
  const requests = [];
  if (artistIds.size) {
    requests.push({ artistIds: [...artistIds], includeLocal: localChanged });
  } else if (localChanged) {
    requests.push({ includeLidarr: false });
  }
  return { requests, fullScheduled: false, deferFull: unresolved };
}

let watcherStarted = false;
let activeWatcher = null;
let lastFullScanAt = 0;
let deferredFullScanTimer = null;

const clearDeferredFullScan = () => {
  if (deferredFullScanTimer) clearTimeout(deferredFullScanTimer);
  deferredFullScanTimer = null;
};

function applyWatcherPlan(plan, { logger, now, fullScanIntervalMs }) {
  for (const request of plan.requests) scheduleLibraryScan(request);
  if (plan.fullScheduled) {
    lastFullScanAt = now;
    clearDeferredFullScan();
    return;
  }
  if (plan.deferFull && !deferredFullScanTimer) {
    const delay = Math.max(0, fullScanIntervalMs - (now - lastFullScanAt));
    logger.info?.(`[Library] Full Lidarr re-index deferred ${Math.round(delay / 1000)}s by the watcher rate limit`);
    deferredFullScanTimer = setTimeout(() => {
      deferredFullScanTimer = null;
      lastFullScanAt = Date.now();
      scheduleLibraryScan({ includeLidarr: true });
    }, delay);
    deferredFullScanTimer.unref?.();
  }
}

export async function refreshLibraryFileWatcher({
  logger = console,
  fullScanIntervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
} = {}) {
  if (!watcherStarted) return false;
  activeWatcher?.close();
  const playlistRoot = path.resolve(resolvePlaylistRoot());
  activeWatcher = createLibraryFileWatcher({
    roots: await resolveLibraryWatchRoots(),
    onChange: (changedRoots, details = {}) => {
      const now = Date.now();
      let lidarrArtistFolders = [];
      try {
        lidarrArtistFolders = loadLidarrArtistFolders();
      } catch (error) {
        logger.warn?.("[Library] Could not load Lidarr artist folders:", error?.message || error);
      }
      const plan = planWatcherScan({
        changedRoots,
        paths: details.paths || [],
        overflow: details.overflow === true,
        playlistRoot,
        lidarrArtistFolders,
        lastFullScanAt,
        now,
        fullScanIntervalMs,
      });
      applyWatcherPlan(plan, { logger, now, fullScanIntervalMs });
    },
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
  clearDeferredFullScan();
  activeWatcher?.close();
  activeWatcher = null;
}
