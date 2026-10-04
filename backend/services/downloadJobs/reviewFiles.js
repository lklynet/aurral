import path from "path";
import fs from "fs/promises";
import { isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { lidarrClient } from "../lidarrClient.js";
import { getPathMappings, resolveLocalPath } from "../pathMappings.js";
import { logger, safeLogDiagnostic } from "../logger.js";

function isInLibraryFolder(filePath) {
  const lidarrRoots = lidarrClient.isEnabled()
    ? lidarrClient.getConfiguredRootFolderPaths()
      .map((root) => resolveLocalPath(root, getPathMappings("lidarr")))
    : [];
  return [resolveDownloadRoot(), ...lidarrRoots]
    .filter(Boolean)
    .some((root) => isPathInsideRoot(filePath, path.resolve(root)));
}

// A review file is a source's copy that Aurral has not imported. Discarding
// it never touches a file in the Downloads Folder or a Lidarr root folder.
export async function discardReviewFile(job) {
  const stagingPath = String(job?.stagingPath || "").trim();
  if (!stagingPath) return;
  const filePath = path.resolve(stagingPath);
  try {
    if (isInLibraryFolder(filePath)) return;
    if (job.downloadSource === "slskd") {
      const { discardSlskdDownload } = await import("../slskdOrchestrator.js");
      await discardSlskdDownload({
        sourcePath: filePath,
        transferId: job.downloadClientId,
        username: job.remoteUsername,
      }).catch((error) => {
        logger.warn("downloads", "Could not clean up the slskd transfer of a review file", {
          jobId: job.id,
          reason: safeLogDiagnostic(error),
        });
      });
    }
    await fs.rm(filePath, { force: true });
    if (path.basename(path.dirname(filePath)) === String(job.id)) {
      await fs.rmdir(path.dirname(filePath)).catch(() => {});
    }
  } catch (error) {
    logger.warn("downloads", "Could not remove a file held for review", {
      jobId: job.id,
      reason: safeLogDiagnostic(error),
    });
  }
}
