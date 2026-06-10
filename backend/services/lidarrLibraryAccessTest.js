import fs from "fs/promises";
import {
  buildTrackFileIndex,
  enrichLidarrTrackWithFiles,
} from "./libraryManager.js";
import { pathsShareDevice } from "./weeklyFlowFileReuse.js";
import { resolveWeeklyFlowRoot } from "./weeklyFlowPaths.js";

function step(id, status, label, extra = {}) {
  return { id, status, label, ...extra };
}

async function pathIsReadable(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
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

export async function runLidarrLibraryAccessTest(lidarrClient, options = {}) {
  const shareDevice = options.pathsShareDevice || pathsShareDevice;
  const steps = [];

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

  if (unreadableRoots.length > 0) {
    const missingPath = unreadableRoots[0];
    steps.push(
      step("mount", "fail", "Aurral can see that folder in the container", {
        detail: missingPath,
        fix: `Lidarr stores files at ${missingPath}, but Aurral cannot read that path. Mount the same host folder into your Aurral container at ${missingPath}, then recreate the Aurral container.`,
      }),
    );
    return { ok: false, steps, sample: null };
  }

  steps.push(
    step("mount", "pass", "Aurral can see that folder in the container", {
      detail: rootPaths.length === 1 ? rootPaths[0] : `${rootPaths.length} root folders`,
    }),
  );

  const sample = await findSampleTrackFile(lidarrClient);
  if (!sample) {
    steps.push(
      step("file", "warn", "Downloaded track available to verify", {
        detail: "No albums with files on disk were found in Lidarr.",
        fix: "After you import at least one album, run this check again to verify playback and reuse.",
      }),
    );
    return { ok: true, steps, sample: null, partial: true };
  }

  if (!(await pathIsReadable(sample.path))) {
    steps.push(
      step("file", "fail", "Aurral can read a downloaded track file", {
        detail: sample.path,
        fix: "Lidarr reports this file path, but Aurral cannot read it. Check Docker mounts and folder permissions (PUID/PGID).",
      }),
    );
    return { ok: false, steps, sample };
  }

  steps.push(step("file", "pass", "Aurral can read a downloaded track file"));

  const flowLibraryRoot = resolveWeeklyFlowRoot();
  const hardlinksAvailable = await shareDevice(sample.path, flowLibraryRoot);
  if (hardlinksAvailable) {
    steps.push(
      step("hardlink", "pass", "Hardlinks are possible between Lidarr and flow files"),
    );
  } else {
    steps.push(
      step("hardlink", "warn", "Hardlinks are not possible with the current mounts", {
        detail: `Lidarr files are under ${sample.path}, but Aurral writes flows under ${flowLibraryRoot}.`,
        fix: "Mount /data into the container and set DOWNLOAD_FOLDER to the absolute in-container path for your downloads folder (for example /data/downloads/tmp). Aurral writes flows there instead of /app/downloads so hardlinks to Lidarr files can work.",
      }),
    );
  }

  steps.push(
    step("ready", "pass", "Ready for library playback and playlist reuse", {
      detail: `${sample.artistName} — ${sample.trackTitle}`,
    }),
  );

  return { ok: true, steps, sample, partial: !hardlinksAvailable };
}
