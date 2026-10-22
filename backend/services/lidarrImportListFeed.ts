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

type LidarrImportListItem = { MusicBrainzId: string; AlbumId?: string };

export const buildLidarrImportListItems = (
  jobs: Pick<DownloadJob, "artistMbid" | "albumMbid">[],
) => {
  const seen = new Set<string>();
  const items: LidarrImportListItem[] = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const artistMbid = String(job?.artistMbid || "").trim();
    if (!artistMbid) continue;
    const albumMbid = String(job?.albumMbid || "").trim();
    const key = albumMbid ? `${artistMbid}\u0001${albumMbid}` : artistMbid;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: LidarrImportListItem = { MusicBrainzId: artistMbid };
    if (albumMbid) entry.AlbumId = albumMbid;
    items.push(entry);
  }
  return items;
};

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
