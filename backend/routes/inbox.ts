import { Hono } from "hono";
import * as v from "valibot";
import { dbOps } from "../db/helpers/index.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";
import { hasPermission } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import type { InboxItem } from "../db/helpers/inbox.ts";
import type { AppEnv, RequestUser } from "../middleware/requestUser.ts";
import { errorStatus } from "./shared/errorStatus.ts";
import { libraryManager } from "../services/libraryManager.ts";
import {
  enqueueInboxRefreshForUser,
  getInboxForUser,
  getInboxRefreshCooldownMs,
  getInboxRefreshStatus,
  markAllInboxItemsRead,
  updateInboxItem,
} from "../services/inboxService.ts";

const lastManualRefresh = new Map<number, number>();
const DISCOVERY_DISMISSAL_MS = 90 * 24 * 60 * 60 * 1000;

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

const listQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.transform((limit) => Math.min(50, Math.max(1, Number(limit)))),
    ),
  ),
});
const refreshInput = v.object({ zip: v.optional(v.union([v.string(), v.number()])) });
const itemUpdate = v.object({
  action: v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.picklist(["add", "read", "save", "unsave", "dismiss"]),
  ),
});

export default new Hono<AppEnv>()
  .basePath("/inbox")
  .use(requireAuth)
  .get("/", validate("query", listQuery), (c) => {
    try {
      const result = getInboxForUser(c.var.user.id, c.req.valid("query"));
      c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
      return c.json(result, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json({ error: "Failed to load inbox", message: failure?.message }, 500);
    }
  })
  .post("/refresh", validate("query", refreshInput), validate("json", refreshInput), async (c) => {
    const userId = c.var.user.id;
    const now = Date.now();
    const last = lastManualRefresh.get(userId) || 0;
    const cooldown = getInboxRefreshCooldownMs() * 3;
    const current = getInboxRefreshStatus(userId);
    if (current.status === "queued" || current.status === "running") {
      return c.json(
        {
          accepted: false,
          queued: false,
          jobId: current.jobId,
          status: current.status,
          refreshStatus: current,
        },
        202,
      );
    }
    if (now - last < cooldown) {
      return c.json(
        {
          error: "Inbox refresh is rate limited",
          retryAfterSeconds: Math.ceil((cooldown - (now - last)) / 1000),
        },
        429,
      );
    }
    try {
      const refresh = await enqueueInboxRefreshForUser(userId, {
        reason: "manual",
        zipCode: String(c.req.valid("json").zip || c.req.valid("query").zip || "").trim(),
        ipAddress: c.var.clientIp,
      });
      lastManualRefresh.set(userId, now);
      const result = getInboxForUser(userId, { limit: 50 });
      return c.json(
        {
          ...result,
          accepted: refresh.queued,
          queued: refresh.queued,
          jobId: refresh.jobId,
          status: refresh.status,
        },
        202,
      );
    } catch (error) {
      const failure = asAppError(error);
      return c.json({ error: "Failed to refresh inbox", message: failure?.message }, 500);
    }
  })
  .post("/read-all", (c) => c.json({ unreadCount: markAllInboxItemsRead(c.var.user.id) }, 200))
  .patch("/:id", validate("json", itemUpdate), async (c) => {
    const user = c.var.user;
    const item = dbOps.getInboxItem(user.id, c.req.param("id"));
    if (!item) return c.json({ error: "Inbox item not found" }, 404);

    const { action } = c.req.valid("json");
    try {
      if (action === "add") {
        if (item.isAdded) return c.json({ item }, 200);
        const result = await addInboxItem(item, user);
        if (result?.error) return c.json({ error: result.error }, 503);
        return c.json(
          { item: updateInboxItem(user.id, item.id, { isAdded: true, isRead: true }) },
          200,
        );
      }
      if (action === "read") {
        return c.json({ item: updateInboxItem(user.id, item.id, { isRead: true }) }, 200);
      }
      if (action === "save" || action === "unsave") {
        return c.json(
          {
            item: updateInboxItem(user.id, item.id, {
              isSaved: action === "save",
              isRead: true,
            }),
          },
          200,
        );
      }
      return c.json(
        {
          item: updateInboxItem(user.id, item.id, {
            isDismissed: true,
            isRead: true,
            dismissedUntil: item.kind === "discovery" ? Date.now() + DISCOVERY_DISMISSAL_MS : null,
          }),
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: failure?.message || "Failed to update inbox item" },
        errorStatus(failure),
      );
    }
  });
