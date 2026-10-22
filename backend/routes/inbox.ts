import express, { type Request } from "express";
import { dbOps } from "../db/helpers/index.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";
import { hasPermission } from "../middleware/auth.ts";
import type { InboxItem } from "../db/helpers/inbox.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { requireAuth } from "../middleware/requirePermission.ts";
import { libraryManager } from "../services/libraryManager.ts";
import {
  enqueueInboxRefreshForUser,
  getInboxForUser,
  getInboxRefreshCooldownMs,
  getInboxRefreshStatus,
  markAllInboxItemsRead,
  updateInboxItem,
} from "../services/inboxService.ts";

const router = express.Router();
const lastManualRefresh = new Map();
const DISCOVERY_DISMISSAL_MS = 90 * 24 * 60 * 60 * 1000;

const getUserId = (req: Request) => Number(req.user?.id);

const metadataText = (metadata: InboxItem["metadata"], key: string) => {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
};

async function addInboxItem(item: InboxItem, user: RequestUser) {
  const metadata = item.metadata || {};
  if (item.kind === "release") {
    if (!hasPermission(user, "addAlbum")) {
      const error: AppError = new Error("Permission required: addAlbum");
      error.statusCode = 403;
      throw error;
    }
    return libraryManager.requestAlbumFromSearch({
      albumMbid: metadataText(metadata, "albumMbid"),
      albumName: metadataText(metadata, "albumName"),
      artistMbid: metadataText(metadata, "artistMbid"),
      artistName: metadataText(metadata, "artistName"),
      triggerSearch: true,
      user,
    });
  }
  if (item.kind === "discovery") {
    if (!hasPermission(user, "addArtist")) {
      const error: AppError = new Error("Permission required: addArtist");
      error.statusCode = 403;
      throw error;
    }
    const options = await libraryManager.resolveArtistAddOptions({ user });
    return libraryManager.addArtistWithResolvedOptions(
      metadataText(metadata, "artistMbid") ?? "",
      metadataText(metadata, "artistName") ?? "",
      {
        ...options,
        user,
      },
    );
  }
  const error: AppError = new Error("This inbox item cannot be added");
  error.statusCode = 400;
  throw error;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number.parseInt(String(req.query.limit), 10) || 50));
    const result = await getInboxForUser(getUserId(req), {
      limit,
    });
    res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return res.json(result);
  } catch (error) {
    const failure = asAppError(error);
    return res.status(500).json({ error: "Failed to load inbox", message: failure?.message });
  }
});

router.post("/refresh", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const now = Date.now();
  const last = lastManualRefresh.get(userId) || 0;
  const cooldown = getInboxRefreshCooldownMs() * 3;
  const current = getInboxRefreshStatus(userId);
  if (current.status === "queued" || current.status === "running") {
    return res.status(202).json({
      accepted: false,
      queued: false,
      jobId: current.jobId,
      status: current.status,
      refreshStatus: current,
    });
  }
  if (now - last < cooldown) {
    return res.status(429).json({
      error: "Inbox refresh is rate limited",
      retryAfterSeconds: Math.ceil((cooldown - (now - last)) / 1000),
    });
  }
  try {
    const refresh = await enqueueInboxRefreshForUser(userId, {
      reason: "manual",
      zipCode: String(req.body?.zip || req.query.zip || "").trim(),
      ipAddress: req.ip || "",
    });
    lastManualRefresh.set(userId, now);
    const result = getInboxForUser(userId, { limit: 50 });
    return res.status(202).json({
      ...result,
      accepted: refresh.queued,
      queued: refresh.queued,
      jobId: refresh.jobId,
      status: refresh.status,
    });
  } catch (error) {
    const failure = asAppError(error);
    return res.status(500).json({ error: "Failed to refresh inbox", message: failure?.message });
  }
});

router.post("/read-all", requireAuth, (req, res) => {
  const unreadCount = markAllInboxItemsRead(getUserId(req));
  res.json({ unreadCount });
});

router.patch("/:id", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const item = dbOps.getInboxItem(userId, req.params.id);
  if (!item) return res.status(404).json({ error: "Inbox item not found" });

  const action = String(req.body?.action || "")
    .trim()
    .toLowerCase();
  try {
    if (action === "add") {
      if (item.isAdded) return res.json({ item });
      const result = await addInboxItem(item, req.user!);
      if (result?.error) {
        return res.status(503).json({ error: result.error });
      }
      const updated = updateInboxItem(userId, item.id, {
        isAdded: true,
        isRead: true,
      });
      return res.json({ item: updated });
    }
    if (action === "read") {
      return res.json({ item: updateInboxItem(userId, item.id, { isRead: true }) });
    }
    if (action === "save" || action === "unsave") {
      return res.json({
        item: updateInboxItem(userId, item.id, {
          isSaved: action === "save",
          isRead: true,
        }),
      });
    }
    if (action === "dismiss") {
      return res.json({
        item: updateInboxItem(userId, item.id, {
          isDismissed: true,
          isRead: true,
          dismissedUntil: item.kind === "discovery" ? Date.now() + DISCOVERY_DISMISSAL_MS : null,
        }),
      });
    }
    return res.status(400).json({ error: "Unsupported inbox action" });
  } catch (error) {
    const failure = asAppError(error);
    return res.status(failure?.statusCode || 500).json({
      error: failure?.message || "Failed to update inbox item",
    });
  }
});

export type InboxResponse = ReturnType<typeof getInboxForUser>;

export type InboxItemResponse = { item: ReturnType<typeof updateInboxItem> };

export type InboxReadAllResponse = { unreadCount: number };

export default router;
