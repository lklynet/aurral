import fs from "fs/promises";
import {
  buildTrackFileIndex,
  enrichLidarrTrackWithFiles,
} from "./libraryManager.js";
import { dbOps } from "../config/db-helpers.js";
import {
  detectPathMappings,
  getPathMappings,
  looksLikeExternalOnlyPath,
  resolveLocalPath,
} from "./pathMappings.js";
import { pathsShareDevice } from "./weeklyFlowFileReuse.js";
import { resolveWeeklyFlowRoot } from "./weeklyFlowPaths.js";

function step(id, status, label, extra = {}) {
  return { id, status, label, ...extra };
}

async function pathIsReadable(filePath, mappings = getPathMappings()) {
  if (!filePath) return false;
  const candidates = [filePath, resolveLocalPath(filePath, mappings)];
  const uniqueCandidates = [
    ...new Set(candidates.map((entry) => String(entry || "").trim()).filter(Boolean)),
  ];
  for (const candidate of uniqueCandidates) {
    try {
      await fs.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {}
  }
  return false;
}

async function findSampleTrackFile(lidarrClient) {
  let artists = [];
  try {
    artists = await lidarrClient.request("/artist");
  } catch {
    return null;
  }
  if (!Array.isArray(artists)) return null;

  for (const artist of artists) {
    if (!artist?.id) continue;
    let albums = [];
    try {
      albums = await lidarrClient.request(`/album?artistId=${artist.id}`);
    } catch {
      continue;
    }
    if (!Array.isArray(albums)) continue;

    const album = albums.find((entry) => (entry?.statistics?.sizeOnDisk ?? 0) > 0);
    if (!album?.id) continue;

    const [tracks, trackFiles] = await Promise.all([
      lidarrClient.getTracksByAlbumId(album.id),
      lidarrClient.getTrackFilesByAlbumId(album.id),
    ]);
    if (!Array.isArray(tracks) || tracks.length === 0) continue;

    const trackFileById = buildTrackFileIndex(trackFiles);
    for (const track of tracks) {
      if (track?.hasFile !== true && !track?.trackFileId) continue;
      const enriched = enrichLidarrTrackWithFiles(track, trackFileById);
      const filePath =
        enriched.path ||
        enriched.trackFile?.path ||
        track.path ||
        track.trackFile?.path ||
        null;
      if (!filePath) continue;
      return {
        path: filePath,
        artistName: artist.artistName || artist.name || "Unknown artist",
        albumTitle: album.title || album.albumTitle || "Unknown album",
        trackTitle: track.title || track.trackTitle || "Unknown track",
      };
    }
  }

  return null;
}

async function tryApplyDetectedMappings({
  rootPaths,
  samplePath,
  autoApplyMappings,
}) {
  const externalPaths = [...rootPaths, samplePath].filter(Boolean);
  if (!externalPaths.some(looksLikeExternalOnlyPath)) {
    return { mappings: [], applied: false };
  }

  const detection = await detectPathMappings({
    externalPaths: rootPaths,
    samplePaths: samplePath ? [samplePath] : [],
  });
  if (!detection.verified || !detection.mappings.length) {
    return { mappings: detection.mappings, applied: false, verified: false };
  }

  if (!autoApplyMappings) {
    return { mappings: detection.mappings, applied: false, verified: true };
  }

  const currentSettings = dbOps.getSettings();
  const mergedMappings = [
    ...(Array.isArray(currentSettings.pathMappings) ? currentSettings.pathMappings : []),
    ...detection.mappings,
  ];
  dbOps.updateSettings({
    ...currentSettings,
    pathMappings: mergedMappings,
  });
  return { mappings: detection.mappings, applied: true, verified: true };
}

export async function runLidarrLibraryAccessTest(lidarrClient, options = {}) {
  const shareDevice = options.pathsShareDevice || pathsShareDevice;
  const steps = [];
  let appliedMappings = [];

  const connection = await lidarrClient.testConnection(true);
  if (!connection.connected) {
    steps.push(
      step("api", "fail", "Connected to Lidarr", {
        detail: connection.error || "Connection failed",
        fix: "Check the server URL and API key. From Docker, use a URL Aurral can reach (for example http://lidarr:8686), not only the address you use in a browser.",
      }),
    );
    return { ok: false, steps, sample: null };
  }

  const instanceLabel = connection.instanceName || "Lidarr";
  const versionLabel = connection.version ? ` (${connection.version})` : "";
  steps.push(
    step("api", "pass", "Connected to Lidarr", {
      detail: `${instanceLabel}${versionLabel}`,
    }),
  );

  let rootFolders = [];
  try {
    rootFolders = await lidarrClient.getRootFolders();
  } catch (error) {
    steps.push(
      step("root", "fail", "Root folder in Lidarr", {
        detail: error.message,
        fix: "Confirm Lidarr is running and your API key can read library settings.",
      }),
    );
    return { ok: false, steps, sample: null };
  }

  const rootPaths = (Array.isArray(rootFolders) ? rootFolders : [])
    .map((folder) => String(folder?.path || "").trim())
    .filter(Boolean);

  if (rootPaths.length === 0) {
    steps.push(
      step("root", "fail", "Root folder in Lidarr", {
        fix: "Add a root folder in Lidarr under Settings → Media Management → Root Folders.",
      }),
    );
    return { ok: false, steps, sample: null };
  }

  steps.push(
    step("root", "pass", "Root folder in Lidarr", {
      detail: rootPaths.join(", "),
    }),
  );

  const unreadableRoots = [];
  for (const rootPath of rootPaths) {
    if (!(await pathIsReadable(rootPath))) {
      unreadableRoots.push(rootPath);
    }
  }

  const sample = await findSampleTrackFile(lidarrClient);

  if (unreadableRoots.length > 0) {
    const mappingAttempt = await tryApplyDetectedMappings({
      rootPaths,
      samplePath: sample?.path || null,
      autoApplyMappings: options.autoApplyMappings === true,
    });
    if (mappingAttempt.applied) {
      appliedMappings = mappingAttempt.mappings;
    }

    const stillUnreadable = [];
    for (const rootPath of unreadableRoots) {
      if (!(await pathIsReadable(rootPath))) {
        stillUnreadable.push(rootPath);
      }
    }

    if (stillUnreadable.length > 0) {
      const missingPath = stillUnreadable[0];
      const usesHostPaths = looksLikeExternalOnlyPath(missingPath);
      steps.push(
        step("mount", "fail", "Aurral can see that folder in the container", {
          detail: missingPath,
          fix: usesHostPaths
            ? `Lidarr reports ${missingPath}, but Aurral cannot read that path inside Docker. Mount the shared parent folder (for example N:/ServerFolders/Music:/music), then add a path mapping or run Test library access again to auto-detect it.`
            : `Lidarr stores files at ${missingPath}, but Aurral cannot read that path. Mount the same host folder into your Aurral container at ${missingPath}, then recreate the Aurral container.`,
          suggestedMappings: mappingAttempt.mappings,
        }),
      );
      return { ok: false, steps, sample, suggestedMappings: mappingAttempt.mappings };
    }

    const mappingDetail = appliedMappings
      .map((entry) => `${entry.remote} -> ${entry.local}`)
      .join(", ");
    steps.push(
      step("mapping", "pass", "Path mapping applied for Lidarr files", {
        detail: mappingDetail,
      }),
    );
  }

  steps.push(
    step("mount", "pass", "Aurral can see that folder in the container", {
      detail: rootPaths.length === 1 ? rootPaths[0] : `${rootPaths.length} root folders`,
    }),
  );

  if (!sample) {
    steps.push(
      step("file", "warn", "Downloaded track available to verify", {
        detail: "No albums with files on disk were found in Lidarr.",
        fix: "After you import at least one album, run this check again to verify playback and reuse.",
      }),
    );
    return {
      ok: true,
      steps,
      sample: null,
      partial: true,
      appliedMappings,
    };
  }

  const readableSamplePath = await pathIsReadable(sample.path);
  if (!readableSamplePath) {
    const mappingAttempt = await tryApplyDetectedMappings({
      rootPaths,
      samplePath: sample.path,
      autoApplyMappings: options.autoApplyMappings === true,
    });
    if (mappingAttempt.applied) {
      appliedMappings = mappingAttempt.mappings;
    }
    const retryReadable = await pathIsReadable(sample.path);
    if (!retryReadable) {
      steps.push(
        step("file", "fail", "Aurral can read a downloaded track file", {
          detail: sample.path,
          fix: looksLikeExternalOnlyPath(sample.path)
            ? "Lidarr reports a host path Aurral cannot read inside Docker. Add a path mapping under Settings → Playlists or run Test library access again to auto-detect it."
            : "Lidarr reports this file path, but Aurral cannot read it. Check Docker mounts and folder permissions (PUID/PGID).",
          suggestedMappings: mappingAttempt.mappings,
        }),
      );
      return {
        ok: false,
        steps,
        sample,
        suggestedMappings: mappingAttempt.mappings,
      };
    }
    if (mappingAttempt.applied) {
      steps.push(
        step("mapping", "pass", "Path mapping applied for Lidarr files", {
          detail: mappingAttempt.mappings
            .map((entry) => `${entry.remote} -> ${entry.local}`)
            .join(", "),
        }),
      );
    }
  }

  const resolvedSamplePath =
    readableSamplePath || (await pathIsReadable(sample.path));
  steps.push(step("file", "pass", "Aurral can read a downloaded track file", {
    detail: resolvedSamplePath || sample.path,
  }));

  const flowLibraryRoot = resolveWeeklyFlowRoot();
  const sharedFilesystem = await shareDevice(resolvedSamplePath || sample.path, flowLibraryRoot);
  if (sharedFilesystem) {
    steps.push(
      step("hardlink", "pass", "Lidarr and Aurral downloads share a filesystem", {
        detail: "Playlist M3U files can reference Lidarr paths directly.",
      }),
    );
  } else {
    steps.push(
      step("hardlink", "warn", "Lidarr and Aurral downloads are on different filesystems", {
        detail: `Lidarr files are under ${resolvedSamplePath || sample.path}, but Aurral writes downloads under ${flowLibraryRoot}.`,
        fix: "Mount the same shared root into Aurral, slskd, and Navidrome, then choose that shared downloads path in Settings (for example /data/downloads/aurral).",
      }),
    );
  }

  steps.push(
    step("ready", "pass", "Ready for library playback and playlist reuse", {
      detail: `${sample.artistName} — ${sample.trackTitle}`,
    }),
  );

  return {
    ok: true,
    steps,
    sample: {
      ...sample,
      path: resolvedSamplePath || sample.path,
    },
    partial: !sharedFilesystem,
    appliedMappings,
  };
}
