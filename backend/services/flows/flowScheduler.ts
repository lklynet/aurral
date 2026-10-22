import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import type { FlowConfig } from "../playlists/flowPlaylistConfig.ts";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import { userOps } from "../../db/helpers/index.ts";
import {
  createPlaylistOperationToken,
  markLatestPlaylistOperationToken,
} from "../playlists/playlistOperations.ts";

function isFlowOwnerActive(flow: FlowConfig) {
  const ownerUserId = Number(flow?.ownerUserId);
  if (!Number.isFinite(ownerUserId)) return true;
  const owner = userOps.getUserById(ownerUserId);
  return !owner || owner.status === "active";
}

export async function runScheduledFlowRefresh() {
  if (!isAnyDownloadSourceConfigured()) return;

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) return;

  for (const flow of due) {
    if (!isFlowOwnerActive(flow)) continue;
    try {
      const token = createPlaylistOperationToken();
      const tokenScope = `flow:${flow.id}:scheduled`;
      markLatestPlaylistOperationToken(tokenScope, token);
      await playlistOperationQueue.enqueuePayload({
        kind: "scheduled-flow-refresh",
        label: `scheduled:${flow.id}`,
        flowId: flow.id,
        tokenScope,
        token,
      });
    } catch (error) {
      console.error(`[FlowScheduler] Failed to refresh ${flow.id}:`, error.message);
    }
  }
}
