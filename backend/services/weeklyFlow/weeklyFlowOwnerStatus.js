import { userOps } from "../../db/helpers/index.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";

export function isPlaylistOwnerActive(playlistType) {
  const key = String(playlistType || "").trim();
  const entity = flowPlaylistConfig.getFlow(key) || flowPlaylistConfig.getSharedPlaylist(key);
  if (!entity || entity.ownerUserId == null) return true;
  return userOps.getUserById(Number(entity.ownerUserId))?.status === "active";
}

export function deferForInactiveOwner(payload, job) {
  if (isPlaylistOwnerActive(job?.playlistId || job?.playlistType)) return null;
  return { ...payload, delaySeconds: 30 };
}
