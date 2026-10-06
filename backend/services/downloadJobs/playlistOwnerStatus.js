import { userOps } from "../../db/helpers/index.js";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";

export function isPlaylistOwnerActive(ownerId) {
  const key = String(ownerId || "").trim();
  const entity = flowPlaylistConfig.getFlow(key);
  if (!entity || entity.ownerUserId == null) return true;
  return userOps.getUserById(Number(entity.ownerUserId))?.status === "active";
}

export function deferForInactiveOwner(payload, job) {
  if (isPlaylistOwnerActive(job?.ownerId)) return null;
  return { ...payload, delaySeconds: 30 };
}
