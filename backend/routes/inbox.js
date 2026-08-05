import express from "express";
import { dbOps } from "../db/helpers/index.js";
import { hasPermission } from "../middleware/auth.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { libraryManager } from "../services/libraryManager.js";
import {
  getInboxForUser,
  getInboxRefreshCooldownMs,
  markAllInboxItemsRead,
  updateInboxItem,
} from "../services/inboxService.js";

const router = express.Router();
const lastManualRefresh = new Map();
const DISCOVERY_DISMISSAL_MS = 90 * 24 * 60 * 60 * 1000;

const getUserId = (req) => Number(req.user?.id);

async function addInboxItem(item, user) {
  const metadata = item.metadata || {};
  if (item.kind === "release") {
    if (!hasPermission(user, "addAlbum")) {
      const error = new Error("Permission required: addAlbum");
      error.statusCode = 403;
      throw error;
    }
    return libraryManager.requestAlbumFromSearch({
      albumMbid: metadata.albumMbid,
      albumName: metadata.albumName,
      artistMbid: metadata.artistMbid,
      artistName: metadata.artistName,
      triggerSearch: true,
      user,
    });
  }
  if (item.kind === "discovery") {
    if (!hasPermission(user, "addArtist")) {
      const error = new Error("Permission required: addArtist");
      error.statusCode = 403;
      throw error;
    }
    const options = await libraryManager.resolveArtistAddOptions({ user });
    return libraryManager.addArtistWithResolvedOptions(
      metadata.artistMbid,
      metadata.artistName,
      options,
    );
  }
  const error = new Error("This inbox item cannot be added");
  error.statusCode = 400;
  throw error;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 50));
    const result = await getInboxForUser(getUserId(req), {
      limit,
      zipCode: String(req.query.zip || "").trim(),
      req,
      awaitRefresh: false,
    });
    res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: "Failed to load inbox", message: error.message });
  }
});

router.post("/refresh", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const now = Date.now();
  const last = lastManualRefresh.get(userId) || 0;
  const cooldown = getInboxRefreshCooldownMs() * 3;
  if (now - last < cooldown) {
    return res.status(429).json({
      error: "Inbox refresh is rate limited",
      retryAfterSeconds: Math.ceil((cooldown - (now - last)) / 1000),
    });
  }
  lastManualRefresh.set(userId, now);
  try {
    const result = await getInboxForUser(userId, {
      limit: 50,
      zipCode: String(req.body?.zip || req.query.zip || "").trim(),
      req,
      force: true,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: "Failed to refresh inbox", message: error.message });
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

  const action = String(req.body?.action || "").trim().toLowerCase();
  try {
    if (action === "add") {
      if (item.isAdded) return res.json({ item });
      const result = await addInboxItem(item, req.user);
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
          dismissedUntil:
            item.kind === "discovery" ? Date.now() + DISCOVERY_DISMISSAL_MS : null,
        }),
      });
    }
    return res.status(400).json({ error: "Unsupported inbox action" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to update inbox item",
    });
  }
});

export default router;
