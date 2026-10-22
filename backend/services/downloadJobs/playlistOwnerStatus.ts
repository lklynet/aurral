import { userOps } from "../../db/helpers/index.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import type { JobFields } from "./downloadTracker.ts";

export function isPlaylistOwnerActive(playlistType: string | null | undefined) {
  const key = String(playlistType || "").trim();
  const entity = flowPlaylistConfig.getFlow(key) || flowPlaylistConfig.getStaticPlaylist(key);
  if (!entity || entity.ownerUserId == null) return true;
  return userOps.getUserById(Number(entity.ownerUserId))?.status === "active";
}

export function deferForInactiveOwner<Payload extends object>(
  payload: Payload,
  job: JobFields<"playlistId" | "playlistType"> | null | undefined,
) {
  if (isPlaylistOwnerActive(job?.playlistId || job?.playlistType)) return null;
  return { ...payload, delaySeconds: 30 };
}
