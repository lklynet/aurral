import crypto from "crypto";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";

const tokenEquals = (left: unknown, right: unknown) => {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

export const buildLidarrImportListItems = (jobs: Pick<DownloadJob, "artistMbid" | "status">[]) =>
  [
    ...new Set(
      jobs.flatMap((job) => {
        const artistMbid = job.artistMbid?.trim();
        return artistMbid && job.status !== "saved" ? [artistMbid] : [];
      }),
    ),
  ].map((MusicBrainzId) => ({ MusicBrainzId }));

export const buildFlowLidarrImportList = (flowId: string) => {
  const flow = flowPlaylistConfig.getFlow(flowId);
  if (!flow) return null;
  const jobs = downloadTracker.getByPlaylistType(flowId);
  return buildLidarrImportListItems(jobs);
};

export const verifyFlowLidarrFeedToken = (flowId: string, token: string) => {
  const flow = flowPlaylistConfig.getFlow(flowId);
  if (!flow?.lidarrFeedToken) return null;
  if (!tokenEquals(flow.lidarrFeedToken, token)) return null;
  return flow;
};
