import { dbOps, userOps } from "../../db/helpers/index.ts";
import { discoveryUserRefreshQueue } from "../jobs/queues.ts";
import { websocketService } from "../websocketService.ts";
import {
  getDiscoveryRefreshState,
  markDiscoveryRefreshRequested,
  markInterruptedDiscoveryRefresh,
} from "./persistence.ts";

const USER_REFRESH_DELAY_SECONDS = 10;
const USER_REFRESH_STAGGER_SECONDS = 15;

export const getUserDiscoveryNamespace = (userId: number) => `user:${userId}`;

export const emitUserDiscoveryUpdate = (
  userId: number,
  data: Parameters<typeof websocketService.emitDiscoveryUpdate>[0],
) => websocketService.emitDiscoveryUpdate({ configured: true, ...data }, { userId });

export const enqueueUserRefreshJob = (
  userId: number,
  { reason, delaySeconds }: { reason: string; delaySeconds: number },
) => {
  const requestedAt = Date.now();
  markDiscoveryRefreshRequested(getUserDiscoveryNamespace(userId), requestedAt);
  const operationId = discoveryUserRefreshQueue.enqueue(
    { userId, requestedAt, reason },
    { delayMs: delaySeconds * 1000, priority: -10 },
  );
  emitUserDiscoveryUpdate(userId, {
    isUpdating: true,
    phase: "queued",
    progressMessage: "Waiting to build your recommendations",
  });
  return operationId;
};

export const markInterruptedUserDiscoveryRefresh = (userId: number, error: string) => {
  const namespace = getUserDiscoveryNamespace(userId);
  if (!markInterruptedDiscoveryRefresh(error, { namespace })) return false;
  emitUserDiscoveryUpdate(userId, {
    isUpdating: false,
    phase: "error",
    progressMessage: "Discovery refresh failed",
    error,
  });
  return true;
};

export const requestUserDiscoveryRefresh = (
  userId: number | null,
  {
    reason = "manual",
    delaySeconds = USER_REFRESH_DELAY_SECONDS,
  }: { reason?: string; delaySeconds?: number } = {},
) => {
  if (userId == null || userId <= 0) {
    return { enqueued: false, reason: "not_configured" };
  }
  const { metadata } = dbOps.getDiscoveryCache(getUserDiscoveryNamespace(userId));
  if (getDiscoveryRefreshState(metadata).pending) {
    return { enqueued: false, reason: "queued" };
  }
  const operationId = enqueueUserRefreshJob(userId, { reason, delaySeconds });
  return { enqueued: true, operationId };
};

export const enqueueAllUserDiscoveryRefreshes = (reason: string) => {
  const users = userOps.getAllUsers().filter((user) => (user.status || "active") === "active");
  let queued = 0;
  users.forEach((user, index) => {
    const result = requestUserDiscoveryRefresh(user.id, {
      reason,
      delaySeconds: USER_REFRESH_DELAY_SECONDS + index * USER_REFRESH_STAGGER_SECONDS,
    });
    if (result.enqueued) queued += 1;
  });
  return queued;
};
