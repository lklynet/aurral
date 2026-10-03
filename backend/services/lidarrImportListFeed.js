import crypto from "crypto";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.js";

const tokenEquals = (left, right) => {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

export const buildLidarrImportListItems = (jobs) => {
  const seen = new Set();
  const items = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const artistMbid = String(job?.artistMbid || "").trim();
    if (!artistMbid) continue;
    const albumMbid = String(job?.albumMbid || "").trim();
    const key = albumMbid ? `${artistMbid}\u0001${albumMbid}` : artistMbid;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { MusicBrainzId: artistMbid };
    if (albumMbid) entry.AlbumId = albumMbid;
    items.push(entry);
  }
  return items;
};

export const buildFlowLidarrImportList = (flowId) => {
  const flow = flowPlaylistConfig.getFlow(flowId);
  if (!flow) return null;
  const jobs = downloadTracker.getByPlaylistType(flowId);
  return buildLidarrImportListItems(jobs);
};

export const verifyFlowLidarrFeedToken = (flowId, token) => {
  const flow = flowPlaylistConfig.getFlow(flowId);
  if (!flow?.lidarrFeedToken) return null;
  if (!tokenEquals(flow.lidarrFeedToken, token)) return null;
  return flow;
};
