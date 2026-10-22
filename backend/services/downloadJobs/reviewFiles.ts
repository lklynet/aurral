import path from "path";
import fs from "fs/promises";
import { isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.ts";
import { lidarrClient } from "../lidarrClient.ts";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import type { DownloadJob } from "./downloadTracker.ts";

type ReviewFileJob = Pick<
  DownloadJob,
  "id" | "stagingPath" | "downloadSource" | "downloadClient" | "downloadClientId" | "remoteUsername"
>;

function isInLibraryFolder(filePath: string) {
  const lidarrRoots = lidarrClient.isEnabled()
    ? lidarrClient
        .getConfiguredRootFolderPaths()
        .map((root) => resolveLocalPath(root, getPathMappings("lidarr")))
    : [];
  return [resolveDownloadRoot(), ...lidarrRoots]
    .filter(Boolean)
    .some((root) => isPathInsideRoot(filePath, path.resolve(root)));
}

// A review file is a source's copy that Aurral has not imported. Discarding
// it never touches a file in the Downloads Folder or a Lidarr root folder.
export async function discardReviewFile(job: ReviewFileJob) {
  const stagingPath = String(job?.stagingPath || "").trim();
  if (!stagingPath) return;
  const filePath = path.resolve(stagingPath);
  try {
    if (isInLibraryFolder(filePath)) return;
    let preserveSource = false;
    if (job.downloadSource === "slskd") {
      const { discardSlskdDownload } = await import("../slskdOrchestrator.ts");
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
    } else if (job.downloadSource === "usenet") {
      const { removeReviewedUsenetDownload } = await import("../usenetOrchestrator.ts");
      preserveSource = (await removeReviewedUsenetDownload(job)) === false;
    }
    if (!preserveSource) await fs.rm(filePath, { force: true });
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

// A file a source held for review while the job searched on. One already
// gone was discarded or imported, so its download is left alone.
export async function discardHeldFile(
  jobId: DownloadJob["id"],
  held: DownloadJob["heldForReview"],
) {
  if (!held?.sourcePath || !(await fs.stat(held.sourcePath).catch(() => null))) return;
  await discardReviewFile({
    id: jobId,
    stagingPath: held.sourcePath,
    downloadSource: held.source,
    downloadClient: held.metadata?.downloadClient,
    downloadClientId: held.transferId,
    remoteUsername: held.username,
  });
}
