import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { dbOps } from "../db/helpers/index.js";
import { getCanonicalLibrary } from "./libraryQueryService.js";
import { lidarrClient } from "./lidarrClient.js";
import { slskdClient } from "./slskdClient.js";
import { nzbgetClient } from "./nzbgetClient.js";
import { sabnzbdClient } from "./sabnzbdClient.js";
import { NavidromeClient } from "./navidrome.js";
import { PlexClient } from "./plex.js";
import { runLidarrLibraryAccessTest } from "./lidarrLibraryAccessTest.js";
import { PLAYLIST_LIBRARY_DIR, resolvePlaylistRoot } from "./playlistPaths.js";
import {
  getPathMappings,
  looksLikeExternalOnlyPath,
  resolveLocalPath,
} from "./pathMappings.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { commitImportToPlaylistLibrary } from "./playlistDownloadUtils.js";
import {
  remapLegacyPath as remapLegacyWeeklyFlowPath,
  resolvePlaylistRoot as resolveWeeklyFlowRoot,
} from "./playlistPaths.js";
import {
  getFilesystemBrowseRoots,
  resolveEnvDownloadFolder,
  getSuggestedDownloadFolderPath,
} from "./downloadFolderConfig.js";

const DOWNLOAD_SPACE_WARNING_BYTES = 1024 ** 3;
const DETAIL_LIST_LIMIT = 6;
const STORAGE_HEALTH_CACHE_TTL_MS = Math.max(
  0,
  Math.floor(Number(process.env.AURRAL_STORAGE_HEALTH_CACHE_MS) || 60 * 1000),
);
const PLAYLIST_FILE_HEALTH_SAMPLE_LIMIT = Math.max(
  50,
  Math.floor(Number(process.env.AURRAL_PLAYLIST_FILE_HEALTH_SAMPLE_LIMIT) || 500),
);

let storageHealthCache = null;
let storageHealthCacheExpiresAt = 0;
let storageHealthCacheKey = "";
let storageHealthInflight = null;
let storageHealthInflightKey = "";

function healthStep(id, status, label, extra = {}) {
  const step = { id, status, label, ...extra };
  if (status === "pass") delete step.fix;
  return step;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatLimitedList(items, limit = DETAIL_LIST_LIMIT) {
  const values = (Array.isArray(items) ? items : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
}

function normalizePathCompare(value) {
  let normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (normalized !== "/" && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function pathCoversPrefix(parentPath, childPath) {
  const parent = normalizePathCompare(parentPath);
  const child = normalizePathCompare(childPath);
  if (!parent || !child) return false;
  if (child === parent) return true;
  if (parent === "/" || /^[a-z]:\/$/i.test(parent)) return child.startsWith(parent);
  return child.startsWith(`${parent}/`);
}

function isAbsolutePathReference(value) {
  const trimmed = String(value || "").trim();
  return (
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\\\\/.test(trimmed) ||
    trimmed.startsWith("//")
  );
}

function getLikelySharedBrowseRoots(browseRoots) {
  const dedicatedRoots = (Array.isArray(browseRoots) ? browseRoots : []).filter(
    (root) => !isFilesystemRootPath(root),
  );
  if (String(process.env.FILE_BROWSE_ROOTS || "").trim()) {
    return dedicatedRoots;
  }

  const envDownloadFolder = resolveEnvDownloadFolder();
  return dedicatedRoots.filter((root) => {
    if (pathCoversPrefix("/data", root) || pathCoversPrefix(root, "/data")) {
      return true;
    }
    return (
      envDownloadFolder &&
      (pathCoversPrefix(root, envDownloadFolder) || pathCoversPrefix(envDownloadFolder, root))
    );
  });
}

async function checkPathReadable(filePath, mappingSource = null) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const mappings = getPathMappings(mappingSource || undefined);
  const candidates = [raw, resolveLocalPath(raw, mappings)];
  const uniqueCandidates = [
    ...new Set(candidates.map((entry) => String(entry || "").trim()).filter(Boolean)),
  ];
  for (const candidate of uniqueCandidates) {
    try {
      const stat = await fs.stat(candidate);
      const accessMode = stat.isDirectory()
        ? fs.constants.R_OK | fs.constants.X_OK
        : fs.constants.R_OK;
      await fs.access(candidate, accessMode);
      return candidate;
    } catch {}
  }
  return false;
}

function formatProbeError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${code}${error?.message || "Filesystem operation failed"}`;
}

function formatServiceError(error, fallback) {
  const detail = error?.response?.data ?? error?.message;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail != null) {
    try {
      return JSON.stringify(detail);
    } catch {}
  }
  return fallback;
}

async function runDirectoryWriteProbe(dirPath) {
  const root = String(dirPath || "").trim();
  if (!root) {
    return { ok: false, detail: "No directory configured" };
  }
  const probeDir = path.join(
    root,
    `.aurral-health-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const probeFile = path.join(probeDir, "probe.tmp");
  const renamedFile = path.join(probeDir, "probe-renamed.tmp");
  const contents = "aurral storage health probe\n";
  try {
    await fs.mkdir(probeDir);
    const handle = await fs.open(probeFile, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync().catch((err) => { console.warn(err); });
    } finally {
      await handle.close().catch((err) => { console.warn(err); });
    }
    const readBack = await fs.readFile(probeFile, "utf8");
    if (readBack !== contents) {
      throw new Error("Probe file contents changed after write");
    }
    await fs.rename(probeFile, renamedFile);
    await fs.unlink(renamedFile);
    await fs.rmdir(probeDir);
    return {
      ok: true,
      detail: "Created, read, renamed, and removed a probe file",
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${probeDir}: ${formatProbeError(error)}`,
    };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch((err) => { console.warn(err); });
  }
}

async function getFilesystemSpace(dirPath) {
  if (typeof fs.statfs !== "function") return null;
  try {
    const stats = await fs.statfs(dirPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    const totalBlocks = Number(stats.blocks || 0);
    if (!Number.isFinite(blockSize) || blockSize <= 0) return null;
    return {
      availableBytes: availableBlocks * blockSize,
      totalBytes: totalBlocks > 0 ? totalBlocks * blockSize : null,
    };
  } catch {
    return null;
  }
}

function formatPathAccessDetail(reportedPath, readablePath) {
  const reported = String(reportedPath || "").trim();
  const readable = String(readablePath || "").trim();
  if (!reported || !readable) return reported || readable;
  if (normalizePathCompare(reported) === normalizePathCompare(readable)) {
    return reported;
  }
  return `${reported} -> ${readable}`;
}

async function runDownloadTransferProbe(sourceDir, targetRoot) {
  const probeId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sourcePath = path.join(sourceDir, `.aurral-transfer-${probeId}.tmp`);
  const targetDir = path.join(targetRoot, PLAYLIST_LIBRARY_DIR, `.aurral-health-${probeId}`);
  const targetPath = path.join(targetDir, "transfer.tmp");
  const contents = `aurral transfer health probe ${probeId}\n`;
  let committedPath = null;
  try {
    await fs.writeFile(sourcePath, contents, { flag: "wx" });
    const sourceStat = await fs.stat(sourcePath);
    committedPath = targetPath;
    committedPath = await commitImportToPlaylistLibrary(sourcePath, targetPath);
    const [targetStat, readBack] = await Promise.all([
      fs.stat(committedPath),
      fs.readFile(committedPath, "utf8"),
    ]);
    if (readBack !== contents) {
      throw new Error("Transferred probe contents did not match the source");
    }
    try {
      await fs.stat(sourcePath);
      throw new Error("Transferred probe remained in the download client folder");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const transferMode =
      sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino
        ? "atomic move"
        : "copy and delete";
    return {
      ok: true,
      detail: `Verified ${transferMode}: ${sourceDir} -> ${targetRoot}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${sourceDir} -> ${targetRoot}: ${formatProbeError(error)}`,
    };
  } finally {
    await fs.rm(sourcePath, { force: true }).catch(() => {});
    if (committedPath) {
      await fs.rm(committedPath, { force: true }).catch(() => {});
    }
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildSection(id, title, steps, { skipped = false, skipReason = null } = {}) {
  const status = skipped
    ? "skip"
    : steps.some((entry) => entry.status === "fail")
      ? "fail"
      : steps.some((entry) => entry.status === "warn")
        ? "warn"
        : "pass";
  return {
    id,
    title,
    status,
    steps,
    skipReason,
  };
}

function summarizeResult(sections) {
  const active = sections.filter((entry) => entry.status !== "skip");
  const hasFail = active.some((entry) => entry.status === "fail");
  const hasWarn = active.some((entry) => entry.status === "warn");
  return {
    ok: !hasFail,
    partial: !hasFail && hasWarn,
    sectionCount: sections.length,
    failedCount: active.filter((entry) => entry.status === "fail").length,
    warningCount: active.filter((entry) => entry.status === "warn").length,
  };
}

function getStorageHealthCacheKey() {
  const settings = dbOps.getSettings();
  return JSON.stringify({
    settings,
    downloadTrackerRevision: downloadTracker.getRevision(),
    env: {
      DOWNLOAD_FOLDER: process.env.DOWNLOAD_FOLDER || "",
      FILE_BROWSE_ROOTS: process.env.FILE_BROWSE_ROOTS || "",
      PATH_MAPPINGS: process.env.PATH_MAPPINGS || "",
      AURRAL_DB_PATH: process.env.AURRAL_DB_PATH || "",
    },
  });
}

function isFilesystemRootPath(value) {
  const normalized = normalizePathCompare(value);
  return normalized === "/" || normalized === "";
}

async function checkSharedVolumeSection() {
  const steps = [];
  const browseRoots = getFilesystemBrowseRoots();
  const sharedRoots = getLikelySharedBrowseRoots(browseRoots);

  if (browseRoots.length === 0) {
    return buildSection("volume", "Browsable storage", [], {
      skipped: true,
      skipReason:
        "No filesystem browse roots are configured. Path-specific checks below still verify configured storage.",
    });
  }

  steps.push(
    healthStep("roots", "pass", "Browsable storage roots in Aurral", {
      detail: formatLimitedList(browseRoots),
    }),
  );

  if (sharedRoots.length > 0) {
    steps.push(
      healthStep("shared-mount", "pass", "Dedicated shared media folder detected", {
        detail: formatLimitedList(sharedRoots),
      }),
    );
  } else {
    steps.push(
      healthStep("shared-mount", "pass", "Filesystem browsing is available", {
        detail: formatLimitedList(browseRoots),
      }),
    );
  }

  return buildSection("volume", "Browsable storage", steps);
}

async function checkPathMappingsSection() {
  const mappings = getPathMappings();
  if (mappings.length === 0) {
    return buildSection("path-mappings", "Remote path mappings", [], {
      skipped: true,
      skipReason: "No remote path mappings are configured.",
    });
  }

  const steps = [];
  const relativeRemoteMappings = mappings.filter(
    (mapping) => !isAbsolutePathReference(mapping.remote),
  );
  if (relativeRemoteMappings.length > 0) {
    steps.push(
      healthStep("remote-absolute", "warn", "Remote paths are absolute", {
        detail: formatLimitedList(
          relativeRemoteMappings.map((mapping) => `${mapping.source}: ${mapping.remote}`),
        ),
        fix: "Remote paths should match the absolute path reported by the source app, such as /downloads/complete, N:\\Music, or \\\\server\\share.",
      }),
    );
  } else {
    steps.push(
      healthStep("remote-absolute", "pass", "Remote paths are absolute", {
        detail: `${mappings.length} mapping${mappings.length === 1 ? "" : "s"} configured`,
      }),
    );
  }

  const inaccessibleLocalPaths = [];
  for (const mapping of mappings) {
    try {
      const stat = await fs.stat(mapping.local);
      if (!stat.isDirectory()) {
        inaccessibleLocalPaths.push(`${mapping.source}: ${mapping.local} is not a directory`);
        continue;
      }
      await fs.access(mapping.local, fs.constants.R_OK | fs.constants.X_OK);
    } catch (error) {
      inaccessibleLocalPaths.push(
        `${mapping.source}: ${mapping.remote} -> ${mapping.local} (${formatProbeError(error)})`,
      );
    }
  }

  if (inaccessibleLocalPaths.length > 0) {
    steps.push(
      healthStep("local-readable", "fail", "Mapped local paths are readable directories", {
        detail: formatLimitedList(inaccessibleLocalPaths),
        fix: "Create or mount the local side of each mapping inside the Aurral container. Remove mappings for apps that already share the same container paths.",
      }),
    );
  } else {
    steps.push(
      healthStep("local-readable", "pass", "Mapped local paths are readable directories", {
        detail: formatLimitedList(
          mappings.map((mapping) => `${mapping.source}: ${mapping.remote} -> ${mapping.local}`),
        ),
      }),
    );
  }

  return buildSection("path-mappings", "Remote path mappings", steps);
}

async function checkDownloadsSection() {
  const steps = [];
  const settings = dbOps.getSettings();
  const downloadFolder = String(settings.downloadFolderPath || resolvePlaylistRoot() || "").trim();
  const suggested = getSuggestedDownloadFolderPath();

  if (!downloadFolder) {
    steps.push(
      healthStep("configured", "fail", "Downloads folder is configured", {
        fix: `Choose a downloads folder under your shared mount, for example ${suggested}.`,
      }),
    );
    return buildSection("downloads", "Aurral downloads", steps);
  }

  steps.push(
    healthStep("configured", "pass", "Downloads folder is configured", {
      detail: downloadFolder,
    }),
  );

  let exists = false;
  try {
    const stat = await fs.stat(downloadFolder);
    exists = stat.isDirectory();
  } catch {}

  if (!exists) {
    steps.push(
      healthStep("exists", "fail", "Downloads folder exists in the container", {
        detail: downloadFolder,
        fix: "Create the folder or pick a path that already exists inside the mounted volume.",
      }),
    );
    return buildSection("downloads", "Aurral downloads", steps);
  }

  steps.push(
    healthStep("exists", "pass", "Downloads folder exists in the container", {
      detail: downloadFolder,
    }),
  );

  const writeProbe = await runDirectoryWriteProbe(downloadFolder);
  if (!writeProbe.ok) {
    steps.push(
      healthStep("writable", "fail", "Aurral can create and move files", {
        detail: writeProbe.detail,
        fix: "Check container permissions (PUID/PGID), read-only mounts, ACLs, and filesystem permissions for the configured downloads folder.",
      }),
    );
    return buildSection("downloads", "Aurral downloads", steps);
  }

  steps.push(
    healthStep("writable", "pass", "Aurral can create and move files", {
      detail: writeProbe.detail,
    }),
  );

  const space = await getFilesystemSpace(downloadFolder);
  if (space) {
    const detail = space.totalBytes
      ? `${formatBytes(space.availableBytes)} available of ${formatBytes(space.totalBytes)}`
      : `${formatBytes(space.availableBytes)} available`;
    steps.push(
      healthStep(
        "space",
        space.availableBytes < DOWNLOAD_SPACE_WARNING_BYTES ? "warn" : "pass",
        "Downloads filesystem has free space",
        {
          detail,
          fix:
            space.availableBytes < DOWNLOAD_SPACE_WARNING_BYTES
              ? "Free at least 1 GiB before starting large playlist or album downloads."
              : undefined,
        },
      ),
    );
  }

  const playlistLibraryRoot = path.join(downloadFolder, PLAYLIST_LIBRARY_DIR);
  try {
    await fs.mkdir(playlistLibraryRoot, { recursive: true });
    steps.push(
      healthStep("playlist-root", "pass", "Playlist library folder is ready", {
        detail: playlistLibraryRoot,
      }),
    );
  } catch (error) {
    steps.push(
      healthStep("playlist-root", "fail", "Playlist library folder is ready", {
        detail: playlistLibraryRoot,
        fix: error?.message || "Could not create the Aurral playlist library folder.",
      }),
    );
  }

  return buildSection("downloads", "Aurral downloads", steps);
}

async function checkLidarrSection() {
  lidarrClient.updateConfig();
  if (!lidarrClient.isConfigured()) {
    return {
      section: buildSection("lidarr", "Lidarr library", [], {
        skipped: true,
        skipReason: "Lidarr is not configured.",
      }),
      sample: null,
      rootPaths: [],
    };
  }

  const result = await runLidarrLibraryAccessTest(lidarrClient);

  return {
    section: buildSection("lidarr", "Lidarr library", result.steps || []),
    sample: result.sample || null,
    rootPaths: result.rootPaths || [],
  };
}

async function checkDownloadClientSection({
  client,
  key,
  title,
  isEnabled,
  skipReason,
  resolveCompletedPath,
  missingPathFix,
  pathFix,
  connectionLabel = `Connected to ${title}`,
  extraSteps = null,
}) {
  const integrations = dbOps.getSettings()?.integrations || {};
  const config = integrations[key] || {};

  if (!isEnabled(config) || !client.isConfigured()) {
    return buildSection(key, title, [], {
      skipped: true,
      skipReason,
    });
  }

  const steps = [];
  const connection = await client.testConnection({ force: true });
  if (!connection.ok) {
    steps.push(
      healthStep("api", "fail", `Connected to ${title}`, {
        detail: connection.message || "Connection failed",
        fix: `Check the ${key} URL and credentials in Settings → Download Clients.`,
      }),
    );
    return buildSection(key, title, steps);
  }

  steps.push(
    healthStep("api", "pass", connectionLabel, {
      detail: connection.message || `${key} is reachable`,
    }),
  );

  if (extraSteps) {
    const extra = extraSteps(connection);
    steps.push(...extra);
    if (extra.some((s) => s.status === "fail")) {
      return buildSection(key, title, steps);
    }
  }

  const completedPath = resolveCompletedPath(config, connection);
  if (!completedPath) {
    steps.push(
      healthStep("path-reported", "warn", `${title} completed folder is configured`, {
        fix: missingPathFix,
      }),
    );
    return buildSection(key, title, steps);
  }

  steps.push(
    healthStep("path-reported", "pass", `${title} completed folder is configured`, {
      detail: completedPath,
    }),
  );

  const readablePath = await checkPathReadable(completedPath, key);
  if (!readablePath) {
    steps.push(
      healthStep("path-readable", "fail", `Aurral can read ${title} completed files`, {
        detail: completedPath,
        fix: pathFix(completedPath),
      }),
    );
    return buildSection(key, title, steps);
  }

  steps.push(
    healthStep("path-readable", "pass", `Aurral can read ${title} completed files`, {
      detail: formatPathAccessDetail(completedPath, readablePath),
    }),
  );

  const transferProbe = await runDownloadTransferProbe(readablePath, resolvePlaylistRoot());
  if (!transferProbe.ok) {
    steps.push(
      healthStep("transfer", "fail", `Aurral can transfer ${title} completed files`, {
        detail: transferProbe.detail,
        fix: `${pathFix(completedPath)} Also verify that Aurral can create and remove files in the completed folder and has enough free space at the destination.`,
      }),
    );
  } else {
    steps.push(
      healthStep("transfer", "pass", `Aurral can transfer ${title} completed files`, {
        detail: transferProbe.detail,
      }),
    );
  }

  return buildSection(key, title, steps);
}

async function checkSlskdSection() {
  return checkDownloadClientSection({
    client: slskdClient,
    key: "slskd",
    title: "slskd downloads",
    isEnabled: (config) => config.enabled !== false,
    skipReason: "slskd is not configured.",
    resolveCompletedPath: (_, connection) =>
      String(connection.downloadPath || "").trim(),
    missingPathFix:
      "Configure the completed downloads folder in slskd, then make that reported path readable and writable by Aurral through a shared mount or an slskd remote path mapping.",
    pathFix: (downloadPath) =>
      looksLikeExternalOnlyPath(downloadPath)
        ? "slskd reports a host path Aurral cannot read inside Docker. Mount the shared parent folder into both containers, or add an slskd mapping under Settings → Download Clients → Remote Path Mappings."
        : `Mount the same host folder into Aurral at the path slskd uses, or add an slskd mapping for ${downloadPath} under Settings → Download Clients → Remote Path Mappings.`,
    connectionLabel: "slskd API is reachable",
    extraSteps: (connection) => {
      if (connection.soulseekConnected === false) {
        return [
          healthStep("soulseek", "warn", "Soulseek network is not connected", {
            detail: "slskd is started but the network is not connected",
            fix: "Open slskd, log in, and connect to the Soulseek server before starting downloads.",
          }),
        ];
      }
      return [
        healthStep("soulseek", "pass", "Soulseek network is connected", {
          detail: connection.serverState || "Connected",
        }),
      ];
    },
  });
}

async function checkNzbgetSection() {
  return checkDownloadClientSection({
    client: nzbgetClient,
    key: "nzbget",
    title: "NZBGet downloads",
    isEnabled: (config) => config.enabled === true,
    skipReason: "NZBGet is not enabled.",
    resolveCompletedPath: (config, connection) =>
      String(
        config.completedPath ||
          connection.downloadPath ||
          connection.directories?.completedPath ||
          "",
      ).trim(),
    missingPathFix:
      "Set Completed download path under Settings → Download Clients → NZBGet, or configure NZBGet's DestDir so its API reports the completed folder.",
    pathFix: () =>
      "Mount the same host folder into Aurral and NZBGet, or add an NZBGet mapping under Settings → Download Clients → Remote Path Mappings.",
  });
}

async function checkSabnzbdSection() {
  return checkDownloadClientSection({
    client: sabnzbdClient,
    key: "sabnzbd",
    title: "SABnzbd downloads",
    isEnabled: (config) => config.enabled === true,
    skipReason: "SABnzbd is not enabled.",
    resolveCompletedPath: (_config, connection) =>
      String(connection.downloadPath || connection.directories?.destDir || "").trim(),
    missingPathFix:
      "Configure SABnzbd's Completed Download Folder, then make that reported path readable and writable by Aurral through a shared mount or a SABnzbd remote path mapping.",
    pathFix: () =>
      "Mount the same host folder into Aurral and SABnzbd, or add a SABnzbd mapping under Settings → Download Clients → Remote Path Mappings.",
  });
}

function libraryCoversAnyPath(libraryList, candidates) {
  return (Array.isArray(libraryList) ? libraryList : []).find((library) =>
    candidates.some((candidate) => pathCoversPrefix(library?.path, candidate)),
  );
}

async function checkNavidromeSection() {
  const integrations = dbOps.getSettings()?.integrations || {};
  const navidrome = integrations.navidrome || {};
  if (!navidrome.url || !navidrome.username || !navidrome.password) {
    return buildSection("navidrome", "Navidrome playback", [], {
      skipped: true,
      skipReason: "Navidrome is not configured.",
    });
  }

  const steps = [];
  const client = new NavidromeClient(navidrome.url, navidrome.username, navidrome.password);

  try {
    await client.ping();
    steps.push(
      healthStep("api", "pass", "Connected to Navidrome", {
        detail: navidrome.url,
      }),
    );
  } catch (error) {
    steps.push(
      healthStep("api", "fail", "Connected to Navidrome", {
        detail: error?.message || "Connection failed",
        fix: "Check the Navidrome URL, username, and password in Settings → Playback.",
      }),
    );
    return buildSection("navidrome", "Navidrome playback", steps);
  }

  const expectedLibraryPath = path
    .join(resolvePlaylistRoot(), PLAYLIST_LIBRARY_DIR)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const expectedLibraryCandidates = [expectedLibraryPath];

  let libraries = [];
  let librariesListed = true;
  try {
    libraries = await client.getLibraries();
  } catch (error) {
    librariesListed = false;
    steps.push(
      healthStep("libraries", "warn", "Navidrome music libraries are readable", {
        detail: error?.message || "Could not list libraries",
        fix: "Confirm the Navidrome account can manage libraries and that the API is reachable.",
      }),
    );
  }

  const libraryList = Array.isArray(libraries) ? libraries : [];
  if (librariesListed && libraryList.length === 0) {
    steps.push(
      healthStep("libraries", "warn", "Navidrome music libraries are configured", {
        fix: "Add the Aurral playlist folder and any reused Lidarr library folders as Navidrome music libraries, then scan them.",
      }),
    );
  } else if (libraryList.length > 0) {
    steps.push(
      healthStep("libraries", "pass", "Navidrome music libraries are configured", {
        detail: formatLimitedList(
          libraryList.map((entry) => String(entry?.path || "").trim()).filter(Boolean),
        ),
      }),
    );
  }

  const relevantLibraries = libraryList.filter((library) =>
    pathCoversPrefix(library?.path, expectedLibraryPath),
  );
  const unreadableLibraries = [];
  for (const library of relevantLibraries) {
    const libraryPath = String(library?.path || "").trim();
    if (!libraryPath) continue;
    const readablePath = await checkPathReadable(libraryPath);
    if (!readablePath) {
      unreadableLibraries.push(libraryPath);
    }
  }

  if (relevantLibraries.length > 0 && unreadableLibraries.length > 0) {
    steps.push(
      healthStep("library-readable", "fail", "Relevant Navidrome libraries are readable from Aurral", {
        detail: formatLimitedList(unreadableLibraries),
        fix: "Mount the relevant Navidrome music folders into Aurral at the same paths, or verify the corresponding Navidrome libraries separately when the apps have different filesystem views.",
      }),
    );
  } else if (relevantLibraries.length > 0) {
    steps.push(
      healthStep("library-readable", "pass", "Relevant Navidrome libraries are readable from Aurral", {
        detail: formatLimitedList(
          relevantLibraries.map((entry) => String(entry?.path || "").trim()).filter(Boolean),
        ),
      }),
    );
  }

  const playlistLibrary = libraryCoversAnyPath(libraryList, expectedLibraryCandidates);

  if (playlistLibrary) {
    steps.push(
      healthStep("aurral-library", "pass", "Navidrome scans the Aurral playlist folder", {
        detail: playlistLibrary.path,
      }),
    );
  } else {
    steps.push(
      healthStep("aurral-library", "warn", "Navidrome scans the Aurral playlist folder", {
        detail: formatLimitedList(expectedLibraryCandidates),
        fix: "Save Navidrome settings, then create or update a playlist or flow so Aurral can create the playlist library. Add that folder as a music library in Navidrome and scan it.",
      }),
    );
  }

  return buildSection("navidrome", "Navidrome playback", steps);
}

async function checkNativePlaybackSection() {
  const library = getCanonicalLibrary({ availableOnly: true });
  const tracks = Array.isArray(library.tracks) ? library.tracks : [];
  if (tracks.length === 0) {
    return buildSection("native-playback", "Aurral-native playback", [
      healthStep("indexed", "warn", "Canonical media is ready for native playback", {
        fix: "Connect Lidarr, let the library index refresh, then run Storage Health again.",
      }),
    ]);
  }

  const sample = tracks.slice(0, PLAYLIST_FILE_HEALTH_SAMPLE_LIMIT);
  const missing = [];
  for (const track of sample) {
    const file = track.files?.find((entry) => entry.available);
    if (!file?.path || !(await checkPathReadable(file.path, file.source))) {
      missing.push(track.title || "Unknown Track");
    }
  }

  const detail = `${tracks.length} canonical track${tracks.length === 1 ? "" : "s"} indexed`;
  if (missing.length > 0) {
    return buildSection("native-playback", "Aurral-native playback", [
      healthStep("indexed", "fail", "Aurral-native playback can read indexed media", {
        detail: `${missing.length} sampled track${missing.length === 1 ? " is" : "s are"} missing or unreadable`,
        fix: "Restore the media mount or rescan the library so stale files become unavailable.",
      }),
    ]);
  }

  return buildSection("native-playback", "Aurral-native playback", [
    healthStep("indexed", "pass", "Aurral-native playback can read indexed media", {
      detail,
    }),
  ]);
}

function appendPortablePath(basePath, child) {
  return `${String(basePath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "")}/${child}`;
}

function getPlexLibraryLocations(libraries) {
  return (Array.isArray(libraries) ? libraries : []).flatMap((library) => {
    const locations = Array.isArray(library?.Location)
      ? library.Location
      : library?.Location
        ? [library.Location]
        : [];
    return locations
      .map((location) => String(location?.path || "").trim())
      .filter(Boolean);
  });
}

async function checkPlexSection() {
  const plex = dbOps.getSettings()?.integrations?.plex || {};
  if (!plex.url || !plex.token) {
    return buildSection("plex", "Plex playback", [], {
      skipped: true,
      skipReason: "Plex is not configured.",
    });
  }

  const steps = [];
  const client = new PlexClient(plex.url, plex.token, plex.clientId);
  try {
    const identity = await client.ping();
    steps.push(
      healthStep("api", "pass", "Connected to Plex", {
        detail: identity?.version ? `${plex.url} (v${identity.version})` : plex.url,
      }),
    );
  } catch (error) {
    steps.push(
      healthStep("api", "fail", "Connected to Plex", {
        detail: formatServiceError(error, "Connection failed"),
        fix: "Reconnect Plex or correct the selected Plex server URL under Settings → Playback.",
      }),
    );
    return buildSection("plex", "Plex playback", steps);
  }

  let libraries;
  try {
    libraries = await client.getLibraries();
  } catch (error) {
    steps.push(
      healthStep("libraries", "fail", "Plex music libraries are readable", {
        detail: formatServiceError(error, "Could not list Plex libraries"),
        fix: "Verify the Plex token can manage libraries and that the selected server is reachable.",
      }),
    );
    return buildSection("plex", "Plex playback", steps);
  }

  const configuredBase = String(plex.downloadsPath || "").trim() || resolvePlaylistRoot();
  const expectedPath = appendPortablePath(configuredBase, PLAYLIST_LIBRARY_DIR);
  const locations = getPlexLibraryLocations(libraries);
  const coveringLocation = locations.find((location) => pathCoversPrefix(location, expectedPath));
  if (coveringLocation) {
    steps.push(
      healthStep("aurral-library", "pass", "Plex scans the Aurral playlist folder", {
        detail: `${expectedPath} (library: ${coveringLocation})`,
      }),
    );
  } else {
    steps.push(
      healthStep("aurral-library", "warn", "Plex scans the Aurral playlist folder", {
        detail: expectedPath,
        fix: "Confirm Plex Aurral Library path is the path the Plex server uses for Aurral's downloads, save settings, then run Sync to Plex so Aurral can create or repair its library.",
      }),
    );
  }

  return buildSection("plex", "Plex playback", steps);
}

async function checkPlaylistFilesSection() {
  const steps = [];
  const weeklyFlowRoot = resolveWeeklyFlowRoot();
  const totalDoneJobs = Number(downloadTracker.getStats()?.done || 0);
  const doneJobs = downloadTracker.getDoneWithFinalPath(PLAYLIST_FILE_HEALTH_SAMPLE_LIMIT);

  if (doneJobs.length === 0) {
    return buildSection("playlists", "Playlist files", [], {
      skipped: true,
      skipReason: "No completed playlist tracks are available to verify yet.",
    });
  }

  let totalMissing = 0;
  let totalUnreadable = 0;
  let totalEmpty = 0;
  let sampleMissing = null;
  let sampleUnreadable = null;
  let sampleEmpty = null;
  for (const job of doneJobs) {
    const localPath = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isFile()) {
        totalMissing += 1;
        if (!sampleMissing) sampleMissing = localPath;
        continue;
      }
      if (stat.size <= 0) {
        totalEmpty += 1;
        if (!sampleEmpty) sampleEmpty = localPath;
      }
      try {
        await fs.access(localPath, fs.constants.R_OK);
      } catch {
        totalUnreadable += 1;
        if (!sampleUnreadable) sampleUnreadable = localPath;
      }
    } catch {
      totalMissing += 1;
      if (!sampleMissing) sampleMissing = localPath;
    }
  }

  if (totalMissing > 0) {
    steps.push(
      healthStep("tracked", "fail", "Completed playlist files are accessible", {
        detail: `${totalMissing} of ${doneJobs.length} completed tracks are missing on disk`,
        fix: sampleMissing
          ? `Example missing path: ${sampleMissing}. Restore the missing file or fix the mount that should contain it, then update the affected playlist or flow.`
          : "Restore the missing files or fix the mount that should contain them, then update the affected playlist or flow.",
      }),
    );
    return buildSection("playlists", "Playlist files", steps);
  }

  if (totalUnreadable > 0) {
    steps.push(
      healthStep("tracked-readable", "fail", "Completed playlist files are readable", {
        detail: `${totalUnreadable} of ${doneJobs.length} completed tracks cannot be read`,
        fix: sampleUnreadable
          ? `Example unreadable path: ${sampleUnreadable}. Check ownership, ACLs, and read permissions for the mounted folder.`
          : "Check ownership, ACLs, and read permissions for the mounted folder.",
      }),
    );
    return buildSection("playlists", "Playlist files", steps);
  }

  if (totalEmpty > 0) {
    steps.push(
      healthStep("tracked-nonempty", "warn", "Completed playlist files are non-empty", {
        detail: `${totalEmpty} of ${doneJobs.length} completed tracks are zero bytes`,
        fix: sampleEmpty
          ? `Example empty path: ${sampleEmpty}. Re-run the affected flow, or remove and add the track again in the affected playlist, so Aurral replaces the empty file.`
          : "Re-run the affected flow, or remove and add the tracks again in the affected playlist, so Aurral replaces empty files.",
      }),
    );
  }

  steps.push(
    healthStep("tracked", "pass", "Completed playlist files are accessible", {
      detail:
        totalDoneJobs > doneJobs.length
          ? `${doneJobs.length} of ${totalDoneJobs} completed tracks sampled`
          : `${doneJobs.length} completed track${doneJobs.length === 1 ? "" : "s"} verified`,
    }),
  );

  return buildSection("playlists", "Playlist files", steps);
}

async function buildStorageHealthCheck() {
  const volumeSection = await checkSharedVolumeSection();
  const downloadsSection = await checkDownloadsSection();
  const { section: lidarrSection } = await checkLidarrSection();

  const sections = [
    volumeSection,
    await checkPathMappingsSection(),
    downloadsSection,
    lidarrSection,
    await checkNativePlaybackSection(),
    await checkSlskdSection(),
    await checkNzbgetSection(),
    await checkSabnzbdSection(),
    await checkNavidromeSection(),
    await checkPlexSection(),
    await checkPlaylistFilesSection(),
  ];

  const summary = summarizeResult(sections);
  return {
    checkedAt: new Date().toISOString(),
    ...summary,
    sections,
  };
}

export async function runStorageHealthCheck({ force = false } = {}) {
  const now = Date.now();
  const cacheKey = getStorageHealthCacheKey();
  if (
    !force &&
    storageHealthCache &&
    storageHealthCacheKey === cacheKey &&
    STORAGE_HEALTH_CACHE_TTL_MS > 0 &&
    now < storageHealthCacheExpiresAt
  ) {
    return {
      ...storageHealthCache,
      cached: true,
    };
  }

  if (!force && storageHealthInflight && storageHealthInflightKey === cacheKey) {
    return storageHealthInflight;
  }

  storageHealthInflightKey = cacheKey;
  storageHealthInflight = buildStorageHealthCheck()
    .then((result) => {
      storageHealthCache = result;
      storageHealthCacheKey = cacheKey;
      storageHealthCacheExpiresAt = Date.now() + STORAGE_HEALTH_CACHE_TTL_MS;
      return result;
    })
    .finally(() => {
      storageHealthInflight = null;
      storageHealthInflightKey = "";
    });

  return storageHealthInflight;
}
