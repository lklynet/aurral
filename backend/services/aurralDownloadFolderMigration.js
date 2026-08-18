import { createReadStream, constants as fsConstants } from "fs";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { dbOps, userOps } from "../db/helpers/index.js";
import {
  AUDIO_EXTENSIONS,
  buildMetadataRecord,
  scanMusicRoot,
} from "./libraryFileScanner.js";
import { getLibraryMediaFile } from "./libraryMediaStore.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { flowPlaylistConfig } from "./weeklyFlow/weeklyFlowPlaylistConfig.js";
import {
  PLAYLIST_LIBRARY_DIR,
  buildAurralTrackDestination,
  isPathInsideRoot,
  remapLegacyPath,
  resolvePlaylistRoot,
} from "./playlistPaths.js";
import { sanitizePathPart } from "./playlistDownloadUtils.js";

export const AURRAL_DOWNLOAD_FOLDER_MIGRATION_VERSION = 1;
export const AURRAL_DOWNLOAD_FOLDER_MIGRATION_SETTING = "aurralDownloadFolderMigration";

const LEGACY_PLAYLIST_ROOTS = [PLAYLIST_LIBRARY_DIR, "aurral-playlists"];
const PARTIAL_EXTENSIONS = new Set([
  ".crdownload",
  ".download",
  ".part",
  ".partial",
  ".tmp",
]);
const UNKNOWN_IDENTITY_VALUES = new Set([
  "unknown",
  "unknown artist",
  "unknown album",
  "unknown track",
]);

const text = (value) => String(value || "").trim();

function log(logger, method, message, details = null) {
  const fn = logger?.[method];
  if (typeof fn !== "function") return;
  fn.call(logger, message, ...(details ? [details] : []));
}

function newMigrationState(rootPath) {
  return {
    version: AURRAL_DOWNLOAD_FOLDER_MIGRATION_VERSION,
    rootPath,
    status: "pending",
    items: {},
    updatedAt: Date.now(),
  };
}

function loadMigrationState(rootPath) {
  const stored = dbOps.getJSONSetting(AURRAL_DOWNLOAD_FOLDER_MIGRATION_SETTING);
  if (
    !stored ||
    stored.version !== AURRAL_DOWNLOAD_FOLDER_MIGRATION_VERSION ||
    path.resolve(String(stored.rootPath || "")) !== rootPath
  ) {
    return newMigrationState(rootPath);
  }
  return {
    ...newMigrationState(rootPath),
    ...stored,
    items: stored.items && typeof stored.items === "object" ? stored.items : {},
  };
}

function saveMigrationState(state) {
  state.updatedAt = Date.now();
  dbOps.setJSONSetting(AURRAL_DOWNLOAD_FOLDER_MIGRATION_SETTING, state);
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function configuredLidarrRoots(options) {
  if (Array.isArray(options.lidarrRoots)) return options.lidarrRoots.filter(Boolean);
  const settings = dbOps.getSettings();
  const users = typeof userOps.getAllUsers === "function" ? userOps.getAllUsers() : [];
  return [
    settings.rootFolderPath,
    settings.integrations?.lidarr?.rootFolderPath,
    ...users.map((user) => user.lidarrRootFolderPath),
  ].filter(Boolean);
}

function isPartialFile(filePath, stat) {
  const extension = path.extname(filePath).toLowerCase();
  return stat.size <= 0 || PARTIAL_EXTENSIONS.has(extension) || path.basename(filePath).startsWith(".");
}

function isCandidateFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) || PARTIAL_EXTENSIONS.has(extension);
}

function jobPlaylistId(job) {
  return text(job?.playlistId || job?.playlistType);
}

async function walkFiles(rootPath, output = []) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(filePath, output);
    } else if (entry.isFile() && isCandidateFile(filePath)) {
      output.push(filePath);
    }
  }
  return output;
}

function safePathPart(value) {
  const result = sanitizePathPart(value, "");
  return result && result !== "." && result !== ".." ? result : null;
}

function legacyPlaylistId(sourcePath, rootPath, knownIds) {
  const relative = path.relative(rootPath, sourcePath).split(path.sep).filter(Boolean);
  if (!relative.length) return null;
  if (LEGACY_PLAYLIST_ROOTS.includes(relative[0])) return relative[1] || null;
  return knownIds.has(relative[0]) ? relative[0] : null;
}

function pathIdentity(sourcePath, rootPath, playlistId, isLegacyRoot) {
  const relative = path.relative(rootPath, sourcePath).split(path.sep).filter(Boolean);
  const start = isLegacyRoot ? 2 : 1;
  const parts = relative.slice(start);
  if (parts.length !== 3) return null;
  const fileName = parts.at(-1);
  const title = path.basename(fileName, path.extname(fileName)).replace(/^\d+(?:[. _-]+|$)/, "").trim();
  return {
    playlistId,
    artistName: parts.at(-3) || null,
    albumName: parts.at(-2) || null,
    trackName: title || null,
  };
}

function isLegacyRootPath(sourcePath, rootPath) {
  const relative = path.relative(rootPath, sourcePath).split(path.sep).filter(Boolean);
  return LEGACY_PLAYLIST_ROOTS.includes(relative[0]);
}

async function resolveJobSourcePath(finalPath, rootPath) {
  const raw = path.resolve(String(finalPath || ""));
  const candidates = [...new Set([raw, remapLegacyPath(raw, rootPath)])];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function collectLegacyFiles(rootPath, knownIds) {
  const roots = LEGACY_PLAYLIST_ROOTS.map((name) => path.join(rootPath, name));
  for (const id of knownIds) roots.push(path.join(rootPath, id));
  const resolvedRoot = path.resolve(rootPath);
  const files = [];
  for (const candidateRoot of [...new Set(roots)]) {
    const resolvedCandidate = path.resolve(candidateRoot);
    if (resolvedCandidate === resolvedRoot || !isPathInsideRoot(resolvedCandidate, resolvedRoot)) {
      continue;
    }
    await walkFiles(resolvedCandidate, files);
  }
  return [...new Set(files.map((filePath) => path.resolve(filePath)))].sort();
}

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function filesMatch(leftPath, rightPath) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const [leftDigest, rightDigest] = await Promise.all([
    fileDigest(leftPath),
    fileDigest(rightPath),
  ]);
  return leftDigest === rightDigest;
}

async function findExistingDestination(targetPath, sourcePath) {
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath, path.extname(targetPath)).toLowerCase();
  const targetExtension = path.extname(targetPath).toLowerCase();
  const sourceStat = await fs.stat(sourcePath);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter(
    (entry) =>
      entry.isFile() &&
      AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      path.basename(entry.name, path.extname(entry.name)).toLowerCase() === baseName,
  );
  candidates.sort(
    (left, right) =>
      Number(path.extname(right.name).toLowerCase() === targetExtension) -
      Number(path.extname(left.name).toLowerCase() === targetExtension),
  );
  for (const entry of candidates) {
    const candidatePath = path.join(directory, entry.name);
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (
      stat?.isFile() &&
      stat.size === sourceStat.size &&
      (await filesMatch(sourcePath, candidatePath))
    ) {
      return candidatePath;
    }
  }
  return null;
}

async function copyWithoutRemovingSource(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const targetStat = await fs.stat(targetPath).catch(() => null);
  if (targetStat?.isFile()) {
    if (await filesMatch(sourcePath, targetPath)) return targetPath;
    throw new Error("Canonical destination conflicts with source content");
  }
  if (targetStat) throw new Error("Canonical destination is not a file");
  const existing = await findExistingDestination(targetPath, sourcePath);
  if (existing) return existing;
  const temporary = path.join(
    path.dirname(targetPath),
    `.aurral-migration-${process.pid}-${Date.now()}-${path.basename(targetPath)}.tmp`,
  );
  try {
    await fs.copyFile(sourcePath, temporary);
    const [sourceStat, temporaryStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(temporary),
    ]);
    if (sourceStat.size !== temporaryStat.size) {
      throw new Error("Migration copy did not match source size");
    }
    await fs.copyFile(temporary, targetPath, fsConstants.COPYFILE_EXCL);
    if (!(await filesMatch(sourcePath, targetPath))) {
      throw new Error("Migration copy content did not match source");
    }
    return targetPath;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function removeSource(sourcePath, rootPath) {
  if (!isPathInsideRoot(sourcePath, rootPath)) {
    throw new Error("Migration source is outside the Aurral root");
  }
  await fs.rm(sourcePath, { force: true });
  let current = path.dirname(sourcePath);
  while (current !== rootPath && isPathInsideRoot(current, rootPath)) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function updateJobPaths(jobs, destination) {
  for (const job of jobs) {
    downloadTracker.updateFinalPath(job.id, destination);
  }
}

async function resolveIdentity(sourcePath, rootPath, playlistId, jobs, metadataReader) {
  const pathValues = pathIdentity(
    sourcePath,
    rootPath,
    playlistId,
    isLegacyRootPath(sourcePath, rootPath),
  );
  const completeJobs = jobs.filter((candidate) =>
    [candidate.artistName, candidate.albumName, candidate.trackName].every((value) => text(value)),
  );
  const jobIdentities = new Set(
    completeJobs
      .map((candidate) => [candidate.artistName, candidate.albumName, candidate.trackName].map(text).join("\u0000")),
  );
  if (jobIdentities.size > 1) return null;
  const job = completeJobs[0] || jobs[0] || null;
  let metadataValues = null;
  if (!job) {
    const metadata = await metadataReader(sourcePath, { skipCovers: true });
    metadataValues = buildMetadataRecord(metadata, sourcePath, rootPath);
  }
  const artistName = text(job?.artistName || metadataValues?.artistName || pathValues?.artistName);
  const albumName = text(job?.albumName || metadataValues?.albumName || pathValues?.albumName);
  const trackName = text(job?.trackName || metadataValues?.title || pathValues?.trackName);
  if (!artistName || !albumName || !trackName) return null;
  if (
    [artistName, albumName, trackName].some((value) =>
      UNKNOWN_IDENTITY_VALUES.has(value.toLowerCase()),
    )
  ) {
    return null;
  }
  return {
    artistName,
    albumName,
    trackName,
    artistMbid: job?.artistMbid || metadataValues?.artistMbid || null,
    albumMbid: job?.albumMbid || metadataValues?.albumMbid || null,
    trackMbid: job?.trackMbid || metadataValues?.trackMbid || null,
  };
}

async function defaultIndexDestination({ rootPath, targetPath, metadataReader }) {
  await scanMusicRoot({ rootPath, source: "aurral", filePaths: [targetPath], metadataReader });
  const media = getLibraryMediaFile({ source: "aurral", path: targetPath });
  if (!media?.available) {
    throw new Error("Destination was not indexed as available Aurral media");
  }
  return media;
}

function itemState(state, sourcePath) {
  return state.items[sourcePath] || {};
}

function retainItem(state, sourcePath, reason, logger) {
  state.items[sourcePath] = {
    ...itemState(state, sourcePath),
    status: "retained",
    reason,
    updatedAt: Date.now(),
  };
  saveMigrationState(state);
  log(logger, "warn", `[AurralMigration] Retained ${sourcePath}: ${reason}`);
}

function resolveOwnership(sourcePath, rootPath, jobs, knownIds) {
  const pathPlaylistId = legacyPlaylistId(sourcePath, rootPath, knownIds);
  const candidates = jobs
    .map((job) => jobPlaylistId(job))
    .filter(Boolean);
  const playlistIds = [...new Set([...candidates, pathPlaylistId].filter(Boolean))];
  const sharedId = playlistIds.find((id) => flowPlaylistConfig.getSharedPlaylist(id)) || null;
  const flowId = playlistIds.find((id) => flowPlaylistConfig.getFlow(id)) || null;
  const playlistId = sharedId || flowId || pathPlaylistId;
  return {
    playlistId,
    sharedPlaylist: playlistId ? flowPlaylistConfig.getSharedPlaylist(playlistId) : null,
    flow: !sharedId && flowId ? flowPlaylistConfig.getFlow(flowId) : null,
  };
}

export async function migrateAurralDownloadFolder(options = {}) {
  const rootPath = path.resolve(options.root || resolvePlaylistRoot());
  const logger = options.logger || console;
  const lidarrRoots = configuredLidarrRoots(options);
  if (lidarrRoots.some((candidate) => pathsOverlap(rootPath, candidate))) {
    const reason = "Aurral DL_FOLDER overlaps a configured Lidarr root";
    log(logger, "error", `[AurralMigration] ${reason}`);
    return { status: "blocked", rootPath, reason, scanned: 0, migrated: 0, removed: 0, retained: 0 };
  }

  const state = loadMigrationState(rootPath);
  if (state.status === "complete") {
    return {
      status: "complete",
      rootPath,
      scanned: 0,
      migrated: 0,
      flowMigrated: 0,
      removed: 0,
      retained: 0,
      failed: 0,
      failures: [],
    };
  }
  const jobs = downloadTracker.getAll().filter((job) => job?.status === "done");
  const knownIds = new Set([
    ...jobs.map(jobPlaylistId).filter(Boolean),
    ...flowPlaylistConfig.getFlows().map((flow) => String(flow.id)),
    ...flowPlaylistConfig.getSharedPlaylists().map((playlist) => String(playlist.id)),
  ]);
  const files = await collectLegacyFiles(rootPath, knownIds);
  const fileSet = new Set(files);
  const jobsByPath = new Map();
  for (const job of jobs) {
    const sourcePath = await resolveJobSourcePath(job.finalPath, rootPath);
    if (!sourcePath || !fileSet.has(sourcePath)) continue;
    const matches = jobsByPath.get(sourcePath) || [];
    matches.push(job);
    jobsByPath.set(sourcePath, matches);
  }

  const metadataReader = options.metadataReader || parseFile;
  const indexDestination = options.indexDestination || defaultIndexDestination;
  const result = {
    status: "complete",
    rootPath,
    scanned: files.length,
    migrated: 0,
    flowMigrated: 0,
    removed: 0,
    retained: 0,
    failed: 0,
    failures: [],
  };

  for (const sourcePath of files) {
    const jobsForSource = jobsByPath.get(sourcePath) || [];
    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch {
      continue;
    }
    if (isPartialFile(sourcePath, stat)) {
      retainItem(state, sourcePath, "partial file", logger);
      result.retained += 1;
      continue;
    }

    const { playlistId, flow, sharedPlaylist } = resolveOwnership(
      sourcePath,
      rootPath,
      jobsForSource,
      knownIds,
    );
    if (!playlistId || (!flow && !sharedPlaylist)) {
      retainItem(state, sourcePath, "ambiguous playlist ownership", logger);
      result.retained += 1;
      continue;
    }
    if (flow && jobsForSource.length === 0) {
      try {
        await removeSource(sourcePath, rootPath);
        state.items[sourcePath] = { status: "removed", reason: "unkept flow media", updatedAt: Date.now() };
        saveMigrationState(state);
        result.removed += 1;
      } catch (error) {
        retainItem(state, sourcePath, `could not remove unkept flow media: ${error.message}`, logger);
        result.failed += 1;
        result.failures.push({ sourcePath, reason: error.message });
      }
      continue;
    }

    let identity;
    try {
      identity = await resolveIdentity(sourcePath, rootPath, playlistId, jobsForSource, metadataReader);
    } catch (error) {
      retainItem(state, sourcePath, `could not resolve media identity: ${error.message}`, logger);
      result.retained += 1;
      continue;
    }
    if (!identity) {
      retainItem(state, sourcePath, "ambiguous media identity", logger);
      result.retained += 1;
      continue;
    }

    const previous = itemState(state, sourcePath);
    const artistDir = safePathPart(identity.artistName);
    const albumDir = safePathPart(identity.albumName);
    const trackName = safePathPart(identity.trackName);
    if (!artistDir || !albumDir || !trackName) {
      retainItem(state, sourcePath, "unsafe media identity", logger);
      result.retained += 1;
      continue;
    }
    const destination = previous.destination || path.resolve(
      rootPath,
      buildAurralTrackDestination(playlistId, artistDir, albumDir, { ephemeral: Boolean(flow) }),
      `${trackName}${path.extname(sourcePath).toLowerCase() || ".mp3"}`,
    );
    if (!isPathInsideRoot(destination, rootPath)) {
      retainItem(state, sourcePath, "destination escaped Aurral root", logger);
      result.retained += 1;
      continue;
    }

    try {
      let committedPath = destination;
      const destinationStat = await fs.stat(destination).catch(() => null);
      const destinationMatches =
        destinationStat?.isFile() &&
        destinationStat.size === stat.size &&
        (await filesMatch(sourcePath, destination));
      if (destinationStat?.isFile() && !destinationMatches) {
        throw new Error("Canonical destination conflicts with source content");
      }
      if (
        !destinationMatches ||
        (previous.status !== "copied" && previous.status !== "indexed" && previous.status !== "referenced")
      ) {
        committedPath = await copyWithoutRemovingSource(sourcePath, destination);
        state.items[sourcePath] = {
          ...previous,
          status: "copied",
          destination: committedPath,
          identity,
          updatedAt: Date.now(),
        };
        saveMigrationState(state);
      }
      if (!flow) {
        await indexDestination({
          rootPath,
          targetPath: committedPath,
          identity,
          jobs: jobsForSource,
          metadataReader,
        });
      } else {
        const destinationStat = await fs.stat(committedPath);
        if (!destinationStat.isFile() || destinationStat.size !== stat.size) {
          throw new Error("Flow destination verification failed");
        }
      }
      state.items[sourcePath] = {
        ...itemState(state, sourcePath),
        status: "indexed",
        destination: committedPath,
        identity,
        updatedAt: Date.now(),
      };
      saveMigrationState(state);
      updateJobPaths(jobsForSource, committedPath);
      state.items[sourcePath] = {
        ...itemState(state, sourcePath),
        status: "referenced",
        updatedAt: Date.now(),
      };
      saveMigrationState(state);
      if (path.resolve(sourcePath) !== path.resolve(committedPath)) {
        await removeSource(sourcePath, rootPath);
      }
      state.items[sourcePath] = {
        ...itemState(state, sourcePath),
        status: "complete",
        updatedAt: Date.now(),
      };
      saveMigrationState(state);
      result.migrated += 1;
      if (flow) result.flowMigrated += 1;
    } catch (error) {
      retainItem(state, sourcePath, `migration verification failed: ${error.message}`, logger);
      result.failed += 1;
      result.failures.push({ sourcePath, reason: error.message });
    }
  }

  for (const [sourcePath, item] of Object.entries(state.items)) {
    if (item?.status !== "referenced" || fileSet.has(sourcePath)) continue;
    state.items[sourcePath] = { ...item, status: "complete", updatedAt: Date.now() };
  }
  state.status = result.failed || result.retained ? "needs-review" : "complete";
  result.status = state.status;
  state.lastResult = {
    scanned: result.scanned,
    migrated: result.migrated,
    flowMigrated: result.flowMigrated,
    removed: result.removed,
    retained: result.retained,
    failed: result.failed,
    failures: result.failures,
  };
  saveMigrationState(state);
  return result;
}
